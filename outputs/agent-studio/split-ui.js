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
  // The real view's header and bottom bar (turn line, message box, chips) as each chat last had them in the focused pane:
  // {top, bottom} px from the pane body's edges to its message list. A pane's copy takes its chat's sizes, so the list keeps
  // the same height and place when focus moves (owner, 2026-11-15: switching focus made the chat jump).
  const barSizes = new Map();
  let lastBar = null,
    barObs = null;
  const panes = new Map(); // group id -> { id, el, strip, body, mirror, mirrorKey, group }
  let drag = null,
    divDrag = null,
    order = [];
  const narrow = () => (root.innerWidth || 1200) < T().NARROW;
  const active = () => !!L && !narrow();
  const selectedKey = () => (host ? host.selectedKey() : '');

  /* Multi-window (store-merge.js): layouts are saved per project ("all" for All chats); a write reads the stored value again and
     changes only this window's layout key, so another window's split panes are never written over. A pop-out saves none. */
  let merged = null;
  function mergedStore() {
    const AS = root.AibStore;
    if (!merged && AS) {
      merged = AS.map(T().STORE, {
        entries: (raw) => T().sanitizeStore(raw).layouts,
        build: (layouts) => ({ v: 1, layouts }),
        writable: (k) => AS.mayWriteProject(k),
      });
      // another window changed its layouts: take them (the layout on screen here stays this window's)
      merged.onChange((layouts) => {
        const mine = K && store && store.layouts ? store.layouts[K] : undefined;
        const next = { v: 1, layouts: { ...layouts } };
        if (mine) next.layouts[K] = mine;
        else delete next.layouts[K];
        store = next;
        merged.adopt(store.layouts);
      });
    }
    return merged;
  }
  function persist() {
    store = T().putLayout(store, K, L);
    const m = mergedStore();
    if (!m) {
      T().write(root.localStorage, store);
      return;
    }
    const mine = store.layouts[K];
    const all = mine ? m.set(K, mine) : m.del(K);
    store = { v: 1, layouts: { ...all, ...(mine ? { [K]: mine } : {}) } };
    if (!mine) delete store.layouts[K];
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
  /* Moving a list in the page (the chat into another pane, the panes into a new stage) resets its scroll position: the scroll
     controller (scroll-controller.js) puts each list back at its own place, which it keeps per chat (not in pixels here). */
  function moved() {
    if (root.ScrollController && root.ScrollController.reattachAll) root.ScrollController.reattachAll();
  }
  /* old main-list scroll code (localStorage aib-scroll-v2 = '0', one release): the lists' pixel positions kept across a move */
  const oldScroll = () => {
    try {
      return root.localStorage && root.localStorage.getItem('aib-scroll-v2') === '0';
    } catch (e) {
      return false;
    }
  };
  function saveScroll() {
    if (!oldScroll()) return [];
    const out = [],
      m = doc().getElementById('messages');
    if (m) out.push([m, m.scrollTop]);
    for (const b of doc().querySelectorAll('.mirror-msgs')) out.push([b, b.scrollTop]);
    return out;
  }
  function restoreScroll(list) {
    for (const [n, top] of list) if (n.isConnected && n.scrollTop !== top) n.scrollTop = top; // old main-list scroll code
  }
  function dropMirror(p) {
    if (!p.mirror) return;
    if (host.mirror && host.mirror.release) host.mirror.release(p.mirror.msgs);
    p.mirror.root.remove();
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
    moved();
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
    for (const p of panes.values()) dropMirror(p);
    main.append(...liveNodes);
    // the file view and the doc frame that sat inside the first pane go back under the chat strip
    const fv = doc().getElementById('fileView'),
      dv = doc().getElementById('docView');
    if (fv && stage.contains(fv)) strip0.after(fv);
    if (dv && stage.contains(dv)) (fv && fv.parentNode === main ? fv : strip0).after(dv);
    for (const p of panes.values()) p.el.classList.remove('has-file');
    stage.remove();
    stage = null;
    panes.clear();
    shapeSig = '';
    strip0.hidden = false;
    doc().body.classList.remove('split-on');
    restoreScroll(keep);
    moved();
  }
  function render() {
    if (!host || !main) return;
    if (!active()) {
      teardown();
      order = [];
      announceChats();
      return;
    }
    const sig = T().shape(L).split('@')[0];
    const reshaped = !stage || sig !== shapeSig;
    if (reshaped) build();
    update();
    if (root.AgentFilesUI && root.AgentFilesUI.placeBoxes) root.AgentFilesUI.placeBoxes(); // a file on screen moves into the first pane
    announceChats();
    // More or fewer panes across: the chat list and Activity give way so every pane keeps its minimum width (resize-ui.js).
    if (reshaped && root.ResizeUI && typeof root.ResizeUI.layout === 'function') root.ResizeUI.layout();
  }
  function measureBar() {
    if (!active() || !L) return;
    const fp = panes.get(L.focus),
      m = doc().getElementById('messages');
    if (!fp || !fp.body || !m || !fp.body.contains(m)) return;
    const b = fp.body.getBoundingClientRect(),
      r = m.getBoundingClientRect();
    if (!r.height || !b.height) return;
    const v = { top: Math.max(0, r.top - b.top), bottom: Math.max(0, b.bottom - r.bottom) };
    lastBar = v;
    const k = selectedKey();
    if (k) barSizes.set(k, v);
  }
  function sizeMirror(p, key) {
    const s = (key && barSizes.get(key)) || lastBar;
    if (!s || !p.mirror) return;
    p.mirror.head.style.height = s.top + 'px';
    p.mirror.foot.style.height = s.bottom + 'px';
  }
  function update() {
    measureBar();
    const keep = saveScroll();
    let move = false;
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
          if (p.mirror.copy && liveNodes[0].parentNode !== p.body) hold(p);
          else dropMirror(p);
          p.mirror = null;
          p.mirrorKey = null;
        }
        if (liveNodes[0].parentNode !== p.body) {
          p.body.append(...liveNodes);
          move = true;
        }
      } else {
        unhold(p);
        drawMirror(p, g);
      }
    });
    restoreScroll(keep);
    if (move) moved();
  }

  // ---- mirrors: the live copy of a chat in a pane that is not focused ---------------------------------------------------
  function drawMirror(p, g) {
    const key = g.active && g.active !== T().DRAFT ? g.active : '';
    const snap = key ? snapOf(key) : null;
    if (snap && p.mirror && p.mirrorKey === key && !p.mirror.copy) {
      // the chat's look arrived (it was in the real view once): the copy takes over from the plain stand-in, keeping its rows
      const msgs = p.mirror.msgs;
      p.mirror.root.remove();
      p.mirror = drawCopy(p, key, snap, msgs);
    }
    if (snap && (!p.mirror || p.mirrorKey !== key)) {
      dropMirror(p);
      const msgs = el('div', 'mirror-msgs');
      msgs.dataset.mirror = key;
      p.mirror = drawCopy(p, key, snap, msgs);
      p.mirrorKey = key;
      const left = host.mirror && host.mirror.take ? host.mirror.take(key) : null;
      if (left && left.length) msgs.append(...left);
      const rows = host.mirror ? host.mirror.rows(key) : null;
      if (rows) host.mirror.paint(msgs, rows);
      else if (host.mirror && host.mirror.wake) host.mirror.wake();
    }
    if (p.mirror && p.mirror.copy) {
      const c = host.convOf(key),
        m = p.mirror;
      const bc = copyState(snap ? snap.bc : '');
      if (m.root.getAttribute('data-bc') !== bc) m.root.setAttribute('data-bc', bc);
      if (m.title) m.title.textContent = c ? host.titleOf(c) : 'Conversation';
      const st = c && host.statusText ? host.statusText(c) : null;
      if (st && m.status) {
        m.status.textContent = st.text;
        m.status.dataset.tone = st.tone;
      }
      if (st && m.turn) m.turn.textContent = st.text;
      if (m.comp) {
        const draft = host.draftOf(key) || '';
        if (m.comp.value !== draft) m.comp.value = draft;
      }
      return;
    }
    if (!p.mirror || p.mirrorKey !== key) {
      dropMirror(p);
      // Same markup and classes as the real header, so it looks the same (header.css styles the <header> element).
      const rootEl = el('div', 'mirror'),
        head = el('header', 'mirror-head'),
        title = el('h1', 'mirror-title'),
        status = el('span', 'mirror-status');
      const main_ = el('div', 'hd-main'),
        line = el('div', 'hd-line'),
        acts = el('div', 'header-actions');
      const msgs = el('div', 'mirror-msgs'),
        foot = el('div', 'mirror-foot'),
        turn = el('div', 'mirror-turn turn-line'),
        comp = el('div', 'mirror-comp');
      msgs.dataset.mirror = key;
      comp.setAttribute('role', 'textbox');
      comp.setAttribute('aria-label', 'Message box. Click to focus this pane.');
      line.append(title);
      main_.append(line);
      acts.append(status);
      head.append(main_, acts);
      foot.append(turn, comp);
      rootEl.append(head, msgs, foot);
      p.body.replaceChildren(rootEl);
      p.mirror = { root: rootEl, head, title, status, msgs, foot, turn, comp };
      p.mirrorKey = key;
      // The chat that just left focus: its pane keeps the rows the real view drew (no empty copy while they are fetched again).
      const left = key && host.mirror && host.mirror.take ? host.mirror.take(key) : null;
      if (left && left.length) msgs.append(...left);
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
    m.turn.textContent = st ? st.text : '';
    m.turn.hidden = !st;
    sizeMirror(p, key);
    const draft = key ? host.draftOf(key) : '';
    m.comp.textContent = draft || (c ? 'Message ' + host.agentName(c) + '… click to reply' : '');
    m.comp.classList.toggle('has-draft', !!draft);
  }
  // ---- the copy of the real view: everything the chat showed in the focused pane ------------------------------------------
  /* Owner, 2026-11-15: "stop changing what is displayed when switching chat focus". The other pane shows the real view's own
     header, bars, message box and chip row as that chat last had them (a snapshot taken when it left the real view, chat.js
     beginConversation -> snapshot), with the live list, title, status and draft filled in. Nothing hides, dims or moves when
     focus moves: only the thin accent line on top of the focused pane changes.
     The copy has no ids (each id becomes data-mid) so the page's getElementById never finds it; the page's id rules are taught to
     style data-mid the same (mirrorCss), and rules that depend on the page's state (body.new-chat ...) follow the state the chat
     had when the snapshot was taken (data-bc on the copy), not the focused chat's. */
  const snaps = new Map(); // chat key -> { nodes: [detached clones of the live view], bc: body classes then }
  const SNAP_KEY = 'aib-split-snap-v1';
  const SNAP_MAX = 6;
  let snapsLoaded = false;
  const FOCUSABLE = 'button, textarea, input, select, summary, a[href], [tabindex]';
  // what a click in the copy passes on to the real view (the title, which renames on click, and plain text only focus the pane)
  const CONTROLS = 'button, textarea, input, select, summary, a[href], .chip, [role="button"]';
  function cloneView(n) {
    if (n.nodeType !== 1) return n.cloneNode(false);
    if (n.id === 'messages') return el('div', 'mirror-slot');
    const c = n.cloneNode(false);
    if (!n.hidden) for (const ch of Array.from(n.childNodes)) c.append(cloneView(ch));
    if (n.tagName === 'TEXTAREA') c.textContent = '';
    if (c.id) {
      c.setAttribute('data-mid', c.id);
      c.removeAttribute('id');
    }
    c.removeAttribute('for');
    if (c.matches && c.matches(FOCUSABLE)) c.setAttribute('tabindex', '-1');
    return c;
  }
  function loadSnaps() {
    if (snapsLoaded) return;
    snapsLoaded = true;
    let raw = null;
    try {
      raw = JSON.parse((root.localStorage && root.localStorage.getItem(SNAP_KEY)) || 'null');
    } catch (e) {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') return;
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (!v || typeof v.html !== 'string' || snaps.has(k)) continue;
      const t = doc().createElement('template');
      t.innerHTML = v.html;
      for (const s of Array.from(t.content.querySelectorAll('script, iframe, object, embed'))) s.remove();
      for (const e of Array.from(t.content.querySelectorAll('*')))
        for (const a of Array.from(e.attributes)) if (/^on/i.test(a.name)) e.removeAttribute(a.name);
      snaps.set(k, { nodes: Array.from(t.content.childNodes), bc: String(v.bc || '') });
    }
  }
  function saveSnaps() {
    if (!L) return; // only split view needs them after a restart
    const keep = new Set(T().tabsFlat(L));
    const out = {};
    let size = 0;
    for (const [k, v] of snaps) {
      if (!keep.has(k)) continue;
      const box = doc().createElement('div');
      box.append(...v.nodes.map((n) => n.cloneNode(true)));
      const html = box.innerHTML;
      size += html.length;
      if (size > 600000) break;
      out[k] = { html, bc: v.bc };
    }
    try {
      if (root.localStorage) root.localStorage.setItem(SNAP_KEY, JSON.stringify(out));
    } catch (e) {
      /* full: the copies are drawn again after the next focus visit */
    }
  }
  // chat.js calls this just before the real view switches to another chat: the chat leaving keeps its look for its pane's copy.
  function snapshot() {
    if (!host || !liveNodes.length) return;
    const k = selectedKey();
    if (!k) return;
    const b = doc().body;
    if (b.classList.contains('new-chat')) return;
    loadSnaps();
    snaps.delete(k);
    snaps.set(k, { nodes: liveNodes.map(cloneView), bc: b.className });
    while (snaps.size > SNAP_MAX) snaps.delete(snaps.keys().next().value);
    saveSnaps();
  }
  function snapOf(key) {
    loadSnaps();
    return snaps.get(key) || null;
  }

  /* The page's style rules, taught to style the copy: "#prompt" also matches [data-mid="prompt"] (same specificity, through
     :is), and a rule that starts with the page's state ("body.new-chat #promptForm") styles the real view by the page's state
     and the copy by the state its chat had (".mirror-copy[data-bc~='new-chat'] [data-mid='promptForm']"). Done once per sheet. */
  const cssDone = typeof WeakSet === 'function' ? new WeakSet() : null;
  function splitTop(s, ch) {
    const out = [];
    let depth = 0,
      q = '',
      cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '\\') {
          cur += c + (s[i + 1] || '');
          i++;
          continue;
        }
        if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ch && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out;
  }
  // Apply fn to the parts of a selector outside quotes.
  function outsideQuotes(s, fn) {
    return s.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([^"']+)/g, (m, quoted, plain) => (quoted ? quoted : fn(plain)));
  }
  const ID_RE = /#(-?[A-Za-z_][\w-]*)/g;
  // The end of the leading compound ("body.new-chat.start-page" in "body.new-chat.start-page #x").
  function compoundEnd(s) {
    let depth = 0,
      q = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && /[\s>+~]/.test(c)) return i;
    }
    return s.length;
  }
  function lastPseudoElement(s) {
    let depth = 0,
      q = '',
      at = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && c === ':' && s[i + 1] === ':') at = i;
    }
    return at;
  }
  function rewriteSelector(list) {
    const out = [];
    let changed = false;
    for (const raw of splitTop(list, ',')) {
      const s = raw.trim();
      const hasId = outsideQuotes(s, (p) => (ID_RE.test(p) ? ((ID_RE.lastIndex = 0), '\u0000') : p)).includes('\u0000');
      ID_RE.lastIndex = 0;
      const isBody = /^body(?![\w-])/.test(s);
      if (!isBody) {
        if (hasId) {
          changed = true;
          out.push(outsideQuotes(s, (p) => p.replace(ID_RE, (m, id) => ':is(#' + id + ',[data-mid="' + id + '"])')));
        } else out.push(s);
        continue;
      }
      changed = true;
      const end = compoundEnd(s),
        head = s.slice(0, end),
        rest = s.slice(end);
      // the real view: as before, never the copy. :where() keeps the rule's specificity exactly as it was: a bare :not(.mirror-copy *)
      // adds a class, so "body > main" would start beating "html body > main" (activity.css) and the right panel's room was taken twice.
      const pe = lastPseudoElement(s),
        guard = ':where(:not(.mirror-copy *))';
      out.push(pe >= 0 ? s.slice(0, pe) + guard + s.slice(pe) : s + guard);
      if (!rest.trim()) continue; // a rule for the body itself
      const state = head
        .slice(4)
        .replace(/\.(-?[A-Za-z_][\w-]*)/g, (m, c) => '[data-bc~="' + c + '"]');
      const copy = '.mirror-copy' + state + outsideQuotes(rest, (p) => p.replace(ID_RE, (m, id) => '[data-mid="' + id + '"]'));
      out.push(copy);
    }
    return changed ? out.join(', ') : null;
  }
  function rewriteRules(rules) {
    for (const r of Array.from(rules || [])) {
      if (typeof r.selectorText === 'string') {
        const next = rewriteSelector(r.selectorText);
        if (next)
          try {
            r.selectorText = next;
          } catch (e) {
            /* a selector the browser would not take: the rule keeps styling the real view only */
          }
      } else if (r.cssRules) rewriteRules(r.cssRules); // @media, @supports
    }
  }
  function mirrorCss() {
    for (const sh of Array.from(doc().styleSheets || [])) {
      if (cssDone && cssDone.has(sh)) continue;
      let rules = null;
      try {
        rules = sh.cssRules;
      } catch (e) {
        rules = null;
      }
      if (!rules) continue;
      if (cssDone) cssDone.add(sh);
      rewriteRules(rules);
    }
  }
  /* The page state the copy is styled by: the chat's own state from its snapshot (a New chat, a subagent open), the window's
     state as it is now (split on, the chat-only mode, a drag in progress). */
  const CHAT_STATE = ['new-chat', 'start-page', 'subchat-open'];
  function copyState(bc) {
    const then = String(bc || '').split(/\s+/).filter((c) => CHAT_STATE.includes(c));
    const now = Array.from(doc().body.classList).filter((c) => !CHAT_STATE.includes(c));
    return now.concat(then).join(' ');
  }
  function drawCopy(p, key, snap, msgs) {
    mirrorCss();
    const rootEl = el('div', 'mirror mirror-copy');
    rootEl.setAttribute('data-bc', copyState(snap.bc));
    rootEl.append(...snap.nodes.map((n) => n.cloneNode(true)));
    const slot = rootEl.querySelector('.mirror-slot');
    msgs.setAttribute('data-mid', 'messages'); // styled exactly as the real list
    if (slot) slot.replaceWith(msgs);
    else rootEl.append(msgs);
    // the copy is a picture: it never submits, never takes the caret (a click focuses the pane, then works on the real one)
    rootEl.addEventListener('submit', (e) => e.preventDefault(), true);
    rootEl.addEventListener('click', (e) => {
      if (e.target && e.target.closest && !e.target.closest('.mirror-msgs')) e.preventDefault();
    });
    const q = (id) => rootEl.querySelector('[data-mid="' + id + '"]');
    p.body.replaceChildren(rootEl);
    // the header's compact / narrow look follows the copy's own width, as the real header's does (views-ui.js)
    const head = rootEl.querySelector(':scope > header'),
      V = root.ChatViewsUI;
    if (head && V && V.fitHeader) {
      V.fitHeader(head, head.clientWidth);
      if (typeof root.ResizeObserver === 'function')
        new root.ResizeObserver((en) => V.fitHeader(head, en[0] && en[0].contentRect ? en[0].contentRect.width : head.clientWidth)).observe(head);
    }
    return { root: rootEl, copy: true, msgs, title: q('title'), status: q('status'), turn: q('turnStatus'), comp: q('prompt') };
  }
  /* The pane just took focus: the real view opens its chat and draws its header and bars again over the next moments (the title,
     the busy state and the buttons arrive with the chat's state). Until the real view shows what the copy showed (or 2 s pass),
     the copy's header and bars stay on top of it, so nothing blinks; the list area is cut out, the real list shows through, and
     every click goes to the real view underneath. */
  const HOLD_IDS = ['title', 'status', 'turnStatus', 'cancel', 'send', 'attachImages', 'markHandled', 'queueBox', 'planDock'];
  function viewSig(find) {
    return HOLD_IDS.map((id) => {
      const n = find(id);
      // a hidden part counts as hidden, whatever its text: the copy (cloneView) leaves out a hidden node's children, so its text
      // there is empty while the real one keeps it ("Mark handled"), and the hold never matched and always ran the full 2 s
      return n ? id + (n.hidden ? ':h' : ':s:' + n.textContent.trim()) : id + ':-';
    }).join('|');
  }
  function hold(p) {
    const m = p.mirror,
      rootEl = m.root,
      msgs = m.msgs;
    if (host.mirror && host.mirror.release) host.mirror.release(msgs);
    const br = p.body.getBoundingClientRect(),
      lr = msgs.getBoundingClientRect();
    const want = viewSig((id) => rootEl.querySelector('[data-mid="' + id + '"]'));
    msgs.style.visibility = 'hidden';
    rootEl.classList.add('mirror-hold');
    if (br.width && lr.height) {
      const x0 = Math.max(0, lr.left - br.left),
        y0 = Math.max(0, lr.top - br.top),
        x1 = x0 + lr.width,
        y1 = y0 + lr.height;
      rootEl.style.clipPath =
        'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ' +
        [x0 + 'px ' + y0 + 'px', x1 + 'px ' + y0 + 'px', x1 + 'px ' + y1 + 'px', x0 + 'px ' + y1 + 'px', x0 + 'px ' + y0 + 'px'].join(', ') +
        ')';
    }
    p.hold = rootEl;
    const t0 = Date.now(),
      raf = root.requestAnimationFrame || ((f) => (root.setTimeout || setTimeout)(f, 16));
    const check = () => {
      if (p.hold !== rootEl) return;
      const real = viewSig((id) => doc().getElementById(id));
      if (real === want || Date.now() - t0 > 2000) unhold(p);
      else raf(check);
    };
    raf(check);
  }
  function unhold(p) {
    if (!p.hold) return;
    p.hold.remove();
    p.hold = null;
  }

  // A click on a control in the copy: after its pane is focused, the same control in the real view (one click does both).
  function pathIn(rootEl, node) {
    const path = [];
    for (let n = node; n && n !== rootEl; n = n.parentElement) {
      const par = n.parentElement;
      if (!par) return null;
      path.unshift(Array.prototype.indexOf.call(par.children, n));
    }
    return path;
  }
  const firstClass = (c) => String(c || '').trim().split(/\s+/)[0] || '';
  function realFor(want) {
    const d = doc();
    if (want.mid) {
      const byId = d.getElementById(want.mid);
      if (byId) return byId;
    }
    if (!want.path || !want.path.length) return null;
    let n = liveNodes[want.path[0]] || null;
    for (let i = 1; n && i < want.path.length; i++) n = n.children[want.path[i]] || null;
    return n && n.tagName === want.tag && firstClass(n.className) === want.cls ? n : null;
  }
  function forward(want) {
    let tries = 0;
    const go = () => {
      const n = realFor(want);
      if (n && !n.hidden && (n.offsetParent !== null || n.tagName === 'TEXTAREA')) {
        if (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT') {
          if (!n.disabled) n.focus();
        } else if (typeof n.click === 'function') n.click();
        return;
      }
      if (++tries < 40) (root.setTimeout || setTimeout)(go, 50); // the chat's chips are drawn again when it opens
    };
    go();
  }

  // For chat.js: the boxes to keep filled, one per pane that shows a chat.
  function mirrorTargets() {
    if (!active()) return [];
    return order
      .filter((g) => g.id !== L.focus && g.active && g.active !== T().DRAFT)
      .map((g) => ({ key: g.active, box: (panes.get(g.id) || {}).mirror ? panes.get(g.id).mirror.msgs : null }))
      .filter((m) => m.box);
  }

  // ---- the right panel: both panes' chats, in pane order, whatever has focus ---------------------------------------------
  // Activity, Changes and Artifacts list every pane's chat (owner, 2026-11-15). The list only changes when a pane shows another
  // chat or the panes come and go, never when focus moves; 'aib-split-chats' tells the panel when it does.
  // Only when two chats are on screen side by side: a pane with the New chat view (or no stage) leaves the panel as it is with one
  // chat, about the open chat (owner, 2026-11-16: one chat on screen showed split sections). body.split-panel marks it for the CSS.
  function paneChats() {
    if (!active() || !stage) return [];
    const list = order.map((g) => (g.active && g.active !== T().DRAFT ? g.active : '')).filter(Boolean);
    return list.length >= 2 ? list : [];
  }
  let chatsSig = null;
  function announceChats() {
    const list = paneChats(),
      sig = list.join('|');
    if (doc() && doc().body) doc().body.classList.toggle('split-panel', list.length >= 2);
    if (sig === chatsSig) return;
    chatsSig = sig;
    try {
      root.dispatchEvent(new root.CustomEvent('aib-split-chats', { detail: { keys: list } }));
    } catch (e) {
      /* no window events (node tests) */
    }
  }
  // What the panel shows for a pane's chat: {key, conv, id (live id or ''), title, dot()}.
  function chatInfo(key) {
    const c = host && key ? host.convOf(key) : null;
    return {
      key,
      conv: c || null,
      id: c && c.live && !c.live.closed && typeof c.live.id === 'string' ? c.live.id : '',
      title: c ? host.titleOf(c) : 'Conversation',
      dot: () => (host && host.dotFor ? host.dotFor(key) : null),
    };
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
  // Two panes are the most: every way to add a third is off.
  const full = () => !!L && T().countGroups(L) >= T().MAX_GROUPS;
  function menuItems(key) {
    const items = [];
    if (!full()) items.push({ id: 'split-right', label: 'Split right', run: () => splitTab(key, 'row') });
    if (!full()) items.push({ id: 'split-down', label: 'Split down', run: () => splitTab(key, 'col') });
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
    // a file showing hides the header (no box at all): the main column's own width stands in
    let hd = main.querySelector(':scope > header') || main;
    if (!hd.getBoundingClientRect().width) hd = main;
    const sr = strip0.getBoundingClientRect(),
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
    if (full()) return;
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
    if (full()) return true; // Ctrl+\ with two panes: nothing
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
    measureBar();
    if (host.mirror && host.mirror.stash) host.mirror.stash(selectedKey());
    L = T().focusGroup(L, gid);
    persist();
    const key = g.active,
      c = key && key !== T().DRAFT ? host.convOf(key) : null;
    if (c && key !== selectedKey()) {
      // Open first, then move the view: the chat you focus takes the rows its pane's copy shows, the chat you leave hands its rows
      // to its pane's copy (chat.js beginConversation). Both happen in this one task, so no frame shows an empty pane.
      host.open(c);
      render();
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
        const zone = T().zoneAt(
          { left: br.left, top: br.top, width: br.width, height: br.height },
          x,
          y,
          undefined,
          T().countGroups(base) >= T().MAX_GROUPS,
        );
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
    // This press only focuses the pane (and passes a control's use on, below): its click must not land on the real view that is
    // now under the pointer (it would start renaming the title, or open and at once close a chip's menu).
    const eat = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    doc().addEventListener('click', eat, true);
    const done = () => {
      doc().removeEventListener('pointerup', done, true);
      (root.setTimeout || setTimeout)(() => doc().removeEventListener('click', eat, true), 0);
    };
    doc().addEventListener('pointerup', done, true);
    const inComposer = !!t.closest('.mirror-comp');
    const copy = t.closest('.mirror-copy'),
      ctl = copy && !t.closest('.mirror-msgs') ? t.closest(CONTROLS) : null;
    if (copy && ctl && copy.contains(ctl) && ctl.getAttribute('data-mid') !== 'title') {
      // a control in the copy: focus the pane now, use the real control once the press ends (after this gesture's own click)
      e.preventDefault();
      const path = pathIn(copy, ctl);
      if (path) {
        // the copy's top-level children line up with the live view's (the list stands in for #messages)
        const want = { mid: ctl.getAttribute('data-mid') || '', path, tag: ctl.tagName, cls: firstClass(ctl.className) };
        const run = () => {
          doc().removeEventListener('pointerup', run, true);
          (root.setTimeout || setTimeout)(() => forward(want), 0);
        };
        doc().addEventListener('pointerup', run, true);
      }
      focusPane(p.dataset.g);
      return;
    }
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
    snapshot();
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
    store = mergedStore() ? { v: 1, layouts: mergedStore().load() } : T().read(root.localStorage);
    wasNarrow = narrow();
    d.addEventListener('pointerdown', onPointerDown, true);
    d.addEventListener('pointermove', onMove);
    d.addEventListener('pointerup', onUp);
    d.addEventListener('pointercancel', onCancel);
    d.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('resize', onResize);
    // The bar grows (a long draft, a chip, a queued message): the copies of other panes keep their own chat's size, and the
    // focused chat's size is remembered for when it leaves focus.
    const msgs = d.getElementById('messages');
    if (msgs && typeof root.ResizeObserver === 'function') {
      barObs = new root.ResizeObserver(() => measureBar());
      barObs.observe(msgs);
    }
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
    paneChats,
    chatInfo,
    menuItems,
    mirrorTargets,
    handleKey,
    splitTab,
    splitFocused,
    snapshot,
    moveTab,
    focusPane,
    newChatIn,
    startTabDrag,
    startCardDrag,
    adoptDrag,
    signature,
    ready: () => !!host,
    // The chat column's floor while panes sit side by side (0 with one pane or under the narrow width).
    minWidth: () => (active() ? T().minStageWidth(L) : 0),
    layout: () => L,
    _store: () => store,
  };
  root.AgentSplitUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
