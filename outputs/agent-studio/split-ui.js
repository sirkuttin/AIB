(function (root) {
  'use strict';
  // Split view, the page side. split-tree.js decides what a layout is; this file draws it and takes the gestures.
  //
  // One pane is the Studio of today: nothing here touches the page until a second pane exists. With two or more, the chat
  // view that already exists (header, message list, message box, Activity feed) is moved into the FOCUSED pane. Every other
  // pane shows a live read-only copy of its chat (a "mirror": title, messages, a message box that focuses the pane when
  // clicked). Focusing a pane opens its chat in the real view, so the Activity column, Changes, Artifacts, Ctrl+K and
  // Ctrl+Tab all follow the focused pane without any of them knowing about panes.
  const T = () => root.AgentSplitTree;
  const doc = () => root.document;
  const el = (tag, cls, text) => {
    const n = doc().createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== '') n.textContent = String(text);
    return n;
  };

  let host = null,
    store = null,
    K = '',
    L = null;
  let main = null,
    strip0 = null,
    liveNodes = [],
    stage = null,
    hintEl = null,
    insEl = null,
    ghost = null;
  let shapeSig = '';
  const panes = new Map(); // group id -> { id, el, strip, body, mirror, mirrorKey, group }
  let drag = null,
    divDrag = null,
    order = [];
  const narrow = () => (root.innerWidth || 1200) < T().NARROW;
  const active = () => !!L && !narrow();
  const selectedKey = () => (host ? host.selectedKey() : '');

  function persist() {
    store = T().putLayout(store, K, L);
    T().write(root.localStorage, store);
  }
  function setLayout(next) {
    L = next && T().countGroups(next) >= 2 ? next : null;
    persist();
  }

  // ---- hooks from the workspace and the page -----------------------------------------------------------------
  // Called every time the conversation list is drawn. o = { key: layout key (project key or "all"), selectedKey, valid: Set of
  // chat keys that may be open (null while the list is not loaded), allowed: Set (the project's own tabs) or null, add: [keys],
  // wantDraft }. Returns { collapsed: [keys] | null }: the tabs of the last pane when the layout shrank to one pane.
  function sync(o) {
    if (!host) return { collapsed: null };
    K = o.key || '';
    let next = T().getLayout(store, K),
      collapsed = null;
    if (next) {
      let r = T().reconcile(next, { valid: o.valid, allowed: o.allowed, add: o.add, draft: o.wantDraft });
      if (r && o.selectedKey) {
        const h = T().holder(r.tree, o.selectedKey);
        if (!h || h.id !== r.focus || h.active !== o.selectedKey) r = T().openTab(r, o.selectedKey);
      }
      if (!r || T().countGroups(r) < 2) {
        collapsed = r
          ? T()
              .tabsFlat(r)
              .filter((t) => t !== T().DRAFT)
          : [];
        next = null;
      } else next = r;
      if (JSON.stringify(next) !== JSON.stringify(T().getLayout(store, K))) {
        L = next;
        persist();
      }
    }
    L = next;
    render();
    return { collapsed };
  }
  // A chat started showing (any way: tab, card, Ctrl+K, a restart): its pane takes focus, or it joins the focused pane.
  function noteOpened(key, layoutKey) {
    if (!host) return;
    K = layoutKey || K;
    L = T().getLayout(store, K);
    if (!L) return;
    const next = T().openTab(L, key);
    if (JSON.stringify(next) !== JSON.stringify(L)) {
      L = next;
      persist();
    }
  }
  function noteDraft(layoutKey) {
    if (!host) return;
    K = layoutKey || K;
    L = T().getLayout(store, K);
    if (!L) return;
    L = T().openDraft(L);
    persist();
  }
  const renameTab = (from, to) => {
    if (!host || !L) return;
    const next = T().rename(L, from, to);
    if (next !== L) {
      L = next;
      persist();
    }
  };
  // The chat to show first after a reload: the focused pane's.
  function restoreKey(layoutKey) {
    const l = T().getLayout(store, layoutKey);
    return l ? T().restoreKey(l) : '';
  }
  const focusTarget = restoreKey;
  const focusTabs = () => {
    const g = L ? T().focused(L) : null;
    return g ? g.tabs.filter((t) => t !== T().DRAFT) : null;
  };
  // A tab was closed (x, middle click, Alt+W). Returns { next, order } or null when the layout is not in use.
  function closeTab(key) {
    if (!L) return null;
    const fg = T().focused(L),
      shown = !!fg && fg.id === L.focus && fg.active === key;
    const next = T().removeTab(L, key);
    const keep = host.selectedKey();
    setLayout(next);
    const nextKey = shown ? (next ? T().restoreKey(next) : '') : keep;
    render();
    return {
      next: nextKey,
      order: L
        ? null
        : next
          ? T()
              .tabsFlat(next)
              .filter((t) => t !== T().DRAFT)
          : [],
    };
  }

  // ---- drawing the stage ---------------------------------------------------------------------------------------
  function getPane(id) {
    let p = panes.get(id);
    if (p) return p;
    p = {
      id,
      el: el('div', 'pane'),
      strip: el('div', 'ws-tabs pane-strip'),
      body: el('div', 'pane-body'),
      mirror: null,
      mirrorKey: null,
      group: null,
    };
    p.el.dataset.g = id;
    p.el.append(p.strip, p.body);
    panes.set(id, p);
    return p;
  }
  function saveScroll() {
    const out = [],
      m = doc().getElementById('messages');
    if (m) out.push([m, m.scrollTop]);
    for (const b of doc().querySelectorAll('.mirror-msgs')) out.push([b, b.scrollTop]);
    return out;
  }
  function restoreScroll(list) {
    for (const [n, top] of list) if (n.isConnected && n.scrollTop !== top) n.scrollTop = top;
  }
  const flexOf = (n) => (Number(n.f) > 0 ? n.f : 1) + ' 1 0';

  function buildNode(n) {
    if (n.k === 'g') {
      const p = getPane(n.id);
      p.group = n;
      p.el.style.flex = flexOf(n);
      return p.el;
    }
    const box = el('div', 'spl ' + n.dir);
    box.dataset.s = n.id;
    box.style.flex = flexOf(n);
    const kids = [];
    n.ch.forEach((c, i) => {
      if (i) {
        const dv = el('div', 'dv');
        dv.dataset.i = String(i);
        dv.setAttribute('role', 'separator');
        dv.setAttribute('aria-orientation', n.dir === 'row' ? 'vertical' : 'horizontal');
        dv.title = 'Drag to resize. Double-click to even out.';
        dv.addEventListener('pointerdown', (e) => startResize(e, n.id, i, dv));
        dv.addEventListener('dblclick', () => {
          if (!L) return;
          L = T().evenOut(L, n.id);
          persist();
          applySizes();
        });
        box.append(dv);
      }
      kids.push(buildNode(c));
      box.append(kids[kids.length - 1]);
    });
    return box;
  }
  function build() {
    const keep = saveScroll(),
      d = doc();
    if (!stage) {
      stage = el('div', 'split-stage');
      stage.id = 'splitStage';
      main.append(stage);
      strip0.hidden = true;
      d.body.classList.add('split-on');
    }
    const ids = new Set(
      T()
        .groups(L.tree)
        .map((g) => g.id),
    );
    for (const id of Array.from(panes.keys()))
      if (!ids.has(id)) {
        const p = panes.get(id);
        p.el.remove();
        panes.delete(id);
      }
    stage.replaceChildren(buildNode(L.tree));
    shapeSig = T().shape(L).split('@')[0];
    restoreScroll(keep);
  }
  function applySizes() {
    if (!stage || !L) return;
    const go = (n) => {
      if (n.k === 'g') {
        const p = panes.get(n.id);
        if (p) p.el.style.flex = flexOf(n);
        return;
      }
      const s = stage.querySelector('[data-s="' + n.id + '"]');
      if (s) s.style.flex = flexOf(n);
      n.ch.forEach(go);
    };
    go(L.tree);
  }
  function teardown() {
    if (!stage) return;
    const keep = saveScroll();
    main.append(...liveNodes);
    stage.remove();
    stage = null;
    panes.clear();
    shapeSig = '';
    strip0.hidden = false;
    doc().body.classList.remove('split-on');
    restoreScroll(keep);
  }
  function render() {
    if (!host || !main) return;
    if (!active()) {
      teardown();
      order = [];
      return;
    }
    const sig = T().shape(L).split('@')[0];
    if (!stage || sig !== shapeSig) build();
    update();
  }
  function update() {
    const keep = saveScroll();
    order = T().groups(L.tree);
    order.forEach((g, i) => {
      const p = getPane(g.id);
      p.group = g;
      p.index = i;
      const foc = g.id === L.focus;
      p.el.classList.toggle('foc', foc);
      p.el.dataset.n = String(i + 1);
      if (foc) {
        if (p.mirror) {
          p.mirror.root.remove();
          p.mirror = null;
          p.mirrorKey = null;
        }
        if (liveNodes[0].parentNode !== p.body) p.body.append(...liveNodes);
      } else drawMirror(p, g);
    });
    restoreScroll(keep);
  }

  // ---- mirrors: the live copy of a chat in a pane that is not focused ---------------------------------------------------
  function drawMirror(p, g) {
    const key = g.active && g.active !== T().DRAFT ? g.active : '';
    if (!p.mirror || p.mirrorKey !== key) {
      if (p.mirror) p.mirror.root.remove();
      // Same markup and classes as the real header, so it looks the same (header.css styles the <header> element).
      const rootEl = el('div', 'mirror'),
        head = el('header', 'mirror-head'),
        title = el('h1', 'mirror-title'),
        status = el('span', 'mirror-status');
      const main_ = el('div', 'hd-main'),
        line = el('div', 'hd-line'),
        acts = el('div', 'header-actions');
      const msgs = el('div', 'mirror-msgs'),
        comp = el('div', 'mirror-comp');
      msgs.dataset.mirror = key;
      comp.setAttribute('role', 'textbox');
      comp.setAttribute('aria-label', 'Message box. Click to focus this pane.');
      line.append(title);
      main_.append(line);
      acts.append(status);
      head.append(main_, acts);
      rootEl.append(head, msgs, comp);
      p.body.replaceChildren(rootEl);
      p.mirror = { root: rootEl, title, status, msgs, comp };
      p.mirrorKey = key;
      const rows = key && host.mirror ? host.mirror.rows(key) : null;
      if (rows) host.mirror.paint(msgs, rows);
      else if (key && host.mirror && host.mirror.wake) host.mirror.wake();
    }
    const c = key ? host.convOf(key) : null,
      m = p.mirror;
    m.title.textContent = c ? host.titleOf(c) : key ? 'Conversation' : 'New chat';
    const st = c && host.statusText ? host.statusText(c) : null;
    m.status.textContent = st ? st.text : '';
    m.status.dataset.tone = st ? st.tone : 'idle';
    m.status.hidden = !st;
    const draft = key ? host.draftOf(key) : '';
    m.comp.textContent = draft || (c ? 'Message ' + host.agentName(c) + '… click to reply' : '');
    m.comp.classList.toggle('has-draft', !!draft);
  }
  // For chat.js: the boxes to keep filled, one per pane that shows a chat.
  function mirrorTargets() {
    if (!active()) return [];
    return order
      .filter((g) => g.id !== L.focus && g.active && g.active !== T().DRAFT)
      .map((g) => ({ key: g.active, box: (panes.get(g.id) || {}).mirror ? panes.get(g.id).mirror.msgs : null }))
      .filter((m) => m.box);
  }

  // ---- strips and keys for the workspace --------------------------------------------------------------------------------
  function paneList() {
    if (!active()) return [];
    return order.map((g, i) => ({
      id: g.id,
      strip: (panes.get(g.id) || {}).strip,
      group: g,
      focused: g.id === L.focus,
      first: i === 0,
      index: i,
    }));
  }
  function menuItems(key) {
    const items = [];
    items.push({ id: 'split-right', label: 'Split right', run: () => splitTab(key, 'row') });
    items.push({ id: 'split-down', label: 'Split down', run: () => splitTab(key, 'col') });
    if (active() && order.length > 1)
      items.push({ id: 'move-next', label: 'Move to next pane', run: () => moveTab(key, 1) });
    return items;
  }

  // ---- the layout to work on --------------------------------------------------------------------------------------------
  // With one pane there is no stored layout: a throwaway one-group layout stands in for it (the strip's tabs).
  function baseLayout() {
    if (L) return L;
    const tabs = host.singleTabs().slice(),
      sel = selectedKey();
    if (sel && !tabs.includes(sel)) tabs.push(sel);
    return T().single(tabs, sel);
  }
  function bodyRect(id) {
    const p = panes.get(id);
    if (p && p.body) return p.body.getBoundingClientRect();
    const hd = main.querySelector(':scope > header') || main,
      sr = strip0.getBoundingClientRect(),
      hr = hd.getBoundingClientRect(),
      mr = main.getBoundingClientRect();
    return {
      left: hr.left,
      top: sr.bottom,
      width: hr.width,
      height: Math.max(0, mr.bottom - sr.bottom),
      right: hr.right,
      bottom: mr.bottom,
    };
  }
  const stripOf = (id) => {
    const p = panes.get(id);
    return p ? p.strip : strip0;
  };
  // Save the new arrangement first, then open the chat: the page's own open flow redraws everything once, consistently.
  function afterChange(next, key) {
    const collapsed = !next || T().countGroups(next) < 2;
    setLayout(next);
    if (collapsed && next)
      host.orderTabs(
        T()
          .tabsFlat(next)
          .filter((t) => t !== T().DRAFT),
      );
    const c = key ? host.convOf(key) : null;
    render();
    if (c && key !== selectedKey()) host.open(c);
    else host.redraw();
  }
  function splitRoom(base, gid, dir) {
    const zone = dir === 'col' ? 'bottom' : 'right';
    return T().canSplit(bodyRect(gid), zone);
  }
  function noRoom() {
    host.notice(
      'There is no room to split this pane: panes stay at least about ' + T().MIN_W + ' by ' + T().MIN_H + ' px.',
    );
  }
  // Ctrl+\ and "Split right" / "Split down": the tab moves to a new pane; a pane with only that tab gets a New chat.
  function splitTab(key, dir) {
    const base = baseLayout(),
      g = T().holder(base.tree, key) || T().focused(base);
    if (!g) return;
    if (!splitRoom(base, g.id, dir)) {
      noRoom();
      return;
    }
    const next = T().splitGroup(base, g.id, dir, key);
    if (next === base) return;
    const fg = T().focused(next);
    if (fg && fg.active === T().DRAFT) {
      setLayout(next);
      render();
      host.showStart();
      host.redraw();
      return;
    }
    afterChange(next, fg ? fg.active : key);
  }
  function splitFocused(dir) {
    if (!host) return false;
    const base = baseLayout(),
      fg = T().focused(base);
    if (!fg) return false;
    if (!splitRoom(base, fg.id, dir)) {
      noRoom();
      return true;
    }
    const key = selectedKey() || fg.active;
    if (key && key !== T().DRAFT && fg.tabs.includes(key)) {
      splitTab(key, dir);
      return true;
    }
    if (!key || key === T().DRAFT) {
      splitTab(T().DRAFT, dir);
      return true;
    }
    return false;
  }
  function moveTab(key, dir) {
    if (!active()) return false;
    const next = T().moveToNeighbour(L, key, dir);
    if (next === L) return false;
    afterChange(next, key);
    return true;
  }
  function focusPane(gid, o) {
    if (!active()) return;
    if (L.focus === gid && !(o && o.force)) return;
    const g = T()
      .groups(L.tree)
      .find((x) => x.id === gid);
    if (!g) return;
    if (host.mirror && host.mirror.stash) host.mirror.stash(selectedKey());
    L = T().focusGroup(L, gid);
    persist();
    const key = g.active,
      c = key && key !== T().DRAFT ? host.convOf(key) : null;
    if (c && key !== selectedKey()) {
      render();
      host.open(c);
    } else {
      render();
      host.redraw();
    }
  }

  // ---- keys --------------------------------------------------------------------------------------------------------------------
  // Returns true when the key was ours. Ctrl+1..9 (focus a pane) is ours only while panes exist; with one pane it stays
  // "jump to tab" as it always was.
  function handleKey(e) {
    if (!host || !e) return false;
    const key = String(e.key || '');
    if (e.metaKey) return false;
    if (doc().querySelector && doc().querySelector('dialog[open]')) return false;
    const done = () => {
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      return true;
    };
    if (e.ctrlKey && !e.altKey && !e.shiftKey && key === '\\') {
      splitFocused('row');
      return done();
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(key) && active()) {
      const g = order[Number(key) - 1];
      if (g) focusPane(g.id);
      return done();
    }
    if (e.ctrlKey && e.altKey && !e.shiftKey && (key === 'ArrowRight' || key === 'ArrowLeft') && active()) {
      const k = selectedKey();
      if (k) moveTab(k, key === 'ArrowRight' ? 1 : -1);
      return done();
    }
    return false;
  }

  // ---- dragging a tab or a chat card -------------------------------------------------------------------------------------
  function ghostFor(key) {
    const g = el('div', 'split-ghost'),
      c = host.convOf(key);
    const dot = host.dotFor ? host.dotFor(key) : null;
    if (dot) g.append(dot);
    g.append(el('span', null, c ? host.titleOf(c) : key));
    doc().body.append(g);
    return g;
  }
  function clearHint() {
    if (hintEl) {
      hintEl.remove();
      hintEl = null;
    }
    if (insEl) {
      insEl.remove();
      insEl = null;
    }
  }
  // The hover target under the pointer, or null (nothing to drop on).
  function targetAt(x, y) {
    const base = drag.base,
      list = active() ? order.map((g) => g.id) : [base.focus];
    for (const id of list) {
      const strip = stripOf(id),
        sr = strip.getBoundingClientRect();
      if (x >= sr.left && x <= sr.right && y >= sr.top && y <= sr.bottom) {
        const group = T()
          .groups(base.tree)
          .find((g) => g.id === id);
        const els = Array.from(strip.querySelectorAll('.ws-tab:not(.ws-tab-draft)')),
          mids = els.map((n) => {
            const r = n.getBoundingClientRect();
            return r.left + r.width / 2;
          });
        const i = T().tabIndexAt(mids, x);
        const idx = group
          ? i < els.length
            ? group.tabs.indexOf(els[i].dataset.key)
            : group.tabs.indexOf(T().DRAFT) >= 0
              ? group.tabs.indexOf(T().DRAFT)
              : group.tabs.length
          : undefined;
        let at = null;
        if (i < els.length) at = els[i].getBoundingClientRect().left - 1;
        else if (els.length) at = els[els.length - 1].getBoundingClientRect().right + 1;
        else at = sr.left + 8;
        return { g: id, zone: 'tabs', idx: idx < 0 ? undefined : idx, strip, sr, at };
      }
      const br = bodyRect(id);
      if (x >= br.left && x <= br.right && y >= br.top && y <= br.bottom) {
        const zone = T().zoneAt({ left: br.left, top: br.top, width: br.width, height: br.height }, x, y);
        const group = T()
          .groups(base.tree)
          .find((g) => g.id === id);
        if (group && group.tabs.includes(drag.key) && (zone === 'center' || group.tabs.length === 1)) return null; // nothing would change
        return { g: id, zone, br };
      }
    }
    return null;
  }
  const LABELS = {
    left: 'Split left',
    right: 'Split right',
    top: 'Split up',
    bottom: 'Split down',
    center: 'Move here',
  };
  function showHint(t) {
    clearHint();
    if (!t) return;
    const d = doc();
    if (t.zone === 'tabs') {
      insEl = el('div', 'split-ins');
      insEl.style.left = Math.round(t.at) + 'px';
      insEl.style.top = Math.round(t.sr.top + 4) + 'px';
      insEl.style.height = Math.round(t.sr.height - 4) + 'px';
      d.body.append(insEl);
      return;
    }
    const f = T().hintRect(t.zone),
      b = t.br;
    hintEl = el('div', 'split-hint');
    hintEl.append(el('span', 'lbl', LABELS[t.zone]));
    hintEl.style.left = Math.round(b.left + f.x * b.width) + 'px';
    hintEl.style.top = Math.round(b.top + f.y * b.height) + 'px';
    hintEl.style.width = Math.round(f.w * b.width) + 'px';
    hintEl.style.height = Math.round(f.h * b.height) + 'px';
    d.body.append(hintEl);
  }
  function beginDrag(e, key, srcEl) {
    if (!host || !key || key === T().DRAFT || e.button !== 0 || e.pointerType === 'touch') return false;
    drag = { key, x0: e.clientX, y0: e.clientY, on: false, srcEl: srcEl || null, tgt: null, base: baseLayout() };
    return true;
  }
  function startTabDrag(e, key, srcEl) {
    return beginDrag(e, key, srcEl);
  }
  function startCardDrag(e, key) {
    return beginDrag(e, key, null);
  }
  // Take over a drag the workspace had started inside its own strip (it pulled the tab out of the strip).
  function adoptDrag(e, key) {
    if (!beginDrag({ button: 0, pointerType: 'mouse', clientX: e.clientX, clientY: e.clientY }, key, null))
      return false;
    lift(e);
    return true;
  }
  function lift(e) {
    drag.on = true;
    ghost = ghostFor(drag.key);
    doc().body.classList.add('split-dragging');
    if (root.getSelection) {
      try {
        root.getSelection().removeAllRanges();
      } catch (err) {
        /* nothing selected */
      }
    }
    if (drag.srcEl && drag.srcEl.classList) drag.srcEl.classList.add('split-lift');
    onMove(e);
  }
  function onMove(e) {
    if (divDrag) {
      moveResize(e);
      return;
    }
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      lift(e);
      return;
    }
    ghost.style.left = e.clientX + 12 + 'px';
    ghost.style.top = e.clientY + 10 + 'px';
    drag.tgt = targetAt(e.clientX, e.clientY);
    showHint(drag.tgt);
  }
  function endDrag(commitIt) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    clearHint();
    doc().body.classList.remove('split-dragging');
    if (d.srcEl && d.srcEl.classList) d.srcEl.classList.remove('split-lift');
    if (!d.on) return;
    const stop = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    doc().addEventListener('click', stop, true);
    (root.setTimeout || setTimeout)(() => doc().removeEventListener('click', stop, true), 0);
    if (commitIt && d.tgt) commitDrop(d);
  }
  function commitDrop(d) {
    const base = d.base,
      t = d.tgt;
    const next = T().drop(base, d.key, t.g, t.zone, t.idx);
    if (next === base || !next) return;
    afterChange(next, d.key);
  }
  function onUp(e) {
    if (divDrag) {
      endResize();
      return;
    }
    endDrag(true);
  }
  function onCancel() {
    if (divDrag) {
      endResize();
      return;
    }
    endDrag(false);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape' && drag && drag.on) {
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    }
  }

  // ---- dividers -------------------------------------------------------------------------------------------------------------------
  function startResize(e, sid, i, dv) {
    if (e.button !== 0 || !L) return;
    const hit = T().find(L.tree, sid);
    if (!hit) return;
    const row = hit.n.dir === 'row',
      a = dv.previousElementSibling,
      b = dv.nextElementSibling;
    const ra = a.getBoundingClientRect(),
      rb = b.getBoundingClientRect();
    divDrag = {
      sid,
      i,
      row,
      a,
      b,
      start: row ? e.clientX : e.clientY,
      a0: row ? ra.width : ra.height,
      total: row ? ra.width + rb.width : ra.height + rb.height,
      minA: row ? T().MIN_W : T().MIN_H,
      dv,
    };
    dv.classList.add('on');
    doc().body.classList.add(row ? 'split-resizing-x' : 'split-resizing-y');
    e.preventDefault();
  }
  function moveResize(e) {
    const r = divDrag,
      pos = r.row ? e.clientX : e.clientY;
    L = T().resize(L, r.sid, r.i, r.a0 + (pos - r.start), r.total, r.minA, r.minA);
    const s = T().find(L.tree, r.sid).n;
    r.a.style.flex = flexOf(s.ch[r.i - 1]);
    r.b.style.flex = flexOf(s.ch[r.i]);
  }
  function endResize() {
    const r = divDrag;
    divDrag = null;
    r.dv.classList.remove('on');
    doc().body.classList.remove('split-resizing-x', 'split-resizing-y');
    persist();
  }

  // ---- clicking in a pane focuses it ---------------------------------------------------------------------------------------------
  function onPointerDown(e) {
    if (!active() || e.button !== 0 || divDrag) return;
    const t = e.target,
      p = t && t.closest ? t.closest('#splitStage .pane') : null;
    if (!p || p.classList.contains('foc')) return;
    if (t.closest('.pane-strip') && t.closest('.ws-tab, button')) return; // tabs and buttons on a strip do their own work
    const inComposer = !!t.closest('.mirror-comp');
    focusPane(p.dataset.g);
    if (inComposer)
      (root.setTimeout || setTimeout)(() => {
        const box = doc().getElementById('prompt');
        if (box && !box.disabled) box.focus();
      }, 0);
  }
  // The "+" on a pane's strip: focus that pane, then start a New chat in it.
  function newChatIn(gid) {
    if (!active() || L.focus === gid) return;
    if (host.mirror && host.mirror.stash) host.mirror.stash(selectedKey());
    L = T().focusGroup(L, gid);
    persist();
    render();
  }

  let resizeTimer = 0,
    wasNarrow = null;
  function onResize() {
    (root.clearTimeout || clearTimeout)(resizeTimer);
    resizeTimer = (root.setTimeout || setTimeout)(() => {
      const n = narrow();
      if (n === wasNarrow) return;
      wasNarrow = n;
      render();
      host.redraw();
    }, 80);
  }

  // A string that changes when a pane's tabs, active tab, focus or the narrow switch changes (the workspace redraws strips on it).
  function signature() {
    if (!L) return '';
    const go = (n) => (n.k === 'g' ? n.id + ':' + n.tabs.join('|') + ':' + n.active : n.ch.map(go).join(','));
    return go(L.tree) + '@' + L.focus + '@' + (narrow() ? 'n' : 'w');
  }

  function init(h) {
    host = h;
    const d = doc();
    main = d.querySelector('main');
    strip0 = d.getElementById('chatTabs');
    if (!main || !strip0) {
      host = null;
      return;
    }
    liveNodes = Array.from(main.children).filter(
      (n) => n !== strip0 && n.id !== 'subagentsPane' && n.id !== 'splitStage',
    );
    store = T().read(root.localStorage);
    wasNarrow = narrow();
    d.addEventListener('pointerdown', onPointerDown, true);
    d.addEventListener('pointermove', onMove);
    d.addEventListener('pointerup', onUp);
    d.addEventListener('pointercancel', onCancel);
    d.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('resize', onResize);
  }

  const api = {
    init,
    sync,
    noteOpened,
    noteDraft,
    renameTab,
    restoreKey,
    focusTarget,
    focusTabs,
    closeTab,
    active,
    panes: paneList,
    menuItems,
    mirrorTargets,
    handleKey,
    splitTab,
    splitFocused,
    moveTab,
    focusPane,
    newChatIn,
    startTabDrag,
    startCardDrag,
    adoptDrag,
    signature,
    ready: () => !!host,
    layout: () => L,
    _store: () => store,
  };
  root.AgentSplitUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
