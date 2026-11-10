(function (root) {
  'use strict';
  // Split view, pure logic: no DOM, no storage, no clock. A layout is plain JSON:
  //   { tree, focus }
  //   tree  = group | split
  //   group = { k: "g", id, tabs: [chatKey, ...], active: chatKey, f }
  //   split = { k: "s", id, dir: "row" | "col", ch: [group | split, ...], f }
  //   focus = id of the focused group
  // f is the node's share of its parent split (any positive number; only the ratios matter).
  // Every function returns a new layout (or the same one when nothing changed); arguments are never mutated.
  // One pane (a single group) is not stored at all: it is the Studio of today, driven by the workspace's own tab list.
  const MIN_W = 360,
    MIN_H = 200; // the smallest pane, in px
  const NARROW = 900; // under this window width the panes collapse to one
  const DRAFT = '__draft__'; // the temporary "New chat" tab; never stored
  const EDGE = 0.3; // a drop within this share of a pane's edge splits it
  const MAX_GROUPS = 24,
    MAX_TABS = 200,
    MAX_LAYOUTS = 60;
  const STORE = 'studio-split-v1';
  const ALL = 'all';

  const isStr = (v) => typeof v === 'string' && v.length > 0;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let uid = 0;
  const nextId = (prefix) => prefix + ++uid;
  const bump = (id) => {
    const n = Number(String(id).replace(/^[a-z]+/, ''));
    if (Number.isFinite(n) && n > uid) uid = n;
  };

  // ---- construction and lookup ----------------------------------------------------------------
  function dedupe(list) {
    const seen = new Set(),
      out = [];
    for (const k of list || [])
      if (isStr(k) && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    return out;
  }
  function group(tabs, active) {
    const list = dedupe(tabs);
    return { k: 'g', id: nextId('g'), tabs: list, active: list.includes(active) ? active : list[0] || '', f: 1 };
  }
  function split(dir, ch) {
    return { k: 's', id: nextId('s'), dir: dir === 'col' ? 'col' : 'row', ch, f: 1 };
  }
  function single(tabs, active) {
    const g = group(tabs, active);
    return { tree: g, focus: g.id };
  }

  function walk(n, fn, parent) {
    if (!n) return;
    if (n.k === 'g') {
      fn(n, parent);
      return;
    }
    n.ch.forEach((c) => walk(c, fn, n));
  }
  function groups(tree) {
    const out = [];
    walk(tree, (g) => out.push(g));
    return out;
  }
  const countGroups = (layout) => (layout && layout.tree ? groups(layout.tree).length : 0);
  // How many panes sit side by side at the widest point (a row adds its children up, a column takes its widest child).
  function across(layout) {
    const go = (n) =>
      !n || n.k !== 's'
        ? 1
        : n.dir === 'row'
          ? n.ch.reduce((sum, c) => sum + go(c), 0)
          : Math.max(1, ...n.ch.map(go));
    return layout && layout.tree ? go(layout.tree) : 0;
  }
  // The narrowest the split stage may get: MIN_W per pane across plus the 5 px dividers between them.
  const minStageWidth = (layout) => {
    const n = across(layout);
    return n > 1 ? n * MIN_W + (n - 1) * 5 : 0;
  };
  function find(tree, id) {
    let hit = null;
    const go = (n, p) => {
      if (hit) return;
      if (n.id === id) {
        hit = { n, p };
        return;
      }
      if (n.k === 's') n.ch.forEach((c) => go(c, n));
    };
    go(tree, null);
    return hit;
  }
  const holder = (tree, tab) => groups(tree).find((g) => g.tabs.includes(tab)) || null;
  const focused = (layout) =>
    layout && layout.tree ? (find(layout.tree, layout.focus) || {}).n || groups(layout.tree)[0] || null : null;
  const tabsFlat = (layout) => (layout && layout.tree ? groups(layout.tree).flatMap((g) => g.tabs) : []);
  const indexOfGroup = (layout, id) => groups(layout.tree).findIndex((g) => g.id === id);

  // ---- tidy up ------------------------------------------------------------------------------
  // Drop empty groups, merge a split into its parent when both run the same way, replace a one-child split by the child.
  function prune(n) {
    if (!n) return null;
    if (n.k === 'g') return n.tabs.length ? n : null;
    let ch = n.ch.map(prune).filter(Boolean);
    const flat = [];
    for (const c of ch) {
      if (c.k === 's' && c.dir === n.dir) {
        const sum = c.ch.reduce((a, x) => a + (x.f || 1), 0) || 1,
          scale = (c.f || 1) / sum;
        for (const g of c.ch) flat.push({ ...g, f: (g.f || 1) * scale });
      } else flat.push(c);
    }
    ch = flat;
    if (!ch.length) return null;
    if (ch.length === 1) return { ...ch[0], f: n.f || 1 };
    return { ...n, ch };
  }
  // The layout after the tree was edited: pruned, with a valid focus (the group that took the space of a vanished one).
  function settle(layout, order) {
    const tree = prune(layout.tree);
    if (!tree) return null;
    let focus = layout.focus;
    if (!find(tree, focus)) {
      const list = groups(tree),
        at = order ? Math.min(Math.max(0, order.index), list.length - 1) : 0;
      focus = list[at].id;
    }
    for (const g of groups(tree)) if (!g.tabs.includes(g.active)) g.active = g.tabs[0];
    return { tree, focus };
  }

  // ---- tabs ----------------------------------------------------------------------------------------
  function takeOut(g, tab) {
    const i = g.tabs.indexOf(tab);
    if (i < 0) return;
    g.tabs.splice(i, 1);
    if (g.active === tab) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] || '';
  }
  // Remove a chat's tab wherever it is (the pane closes if it was the last one).
  function removeTab(layout, tab) {
    const L = clone(layout),
      g = holder(L.tree, tab);
    if (!g) return layout;
    const at = indexOfGroup(L, g.id);
    takeOut(g, tab);
    return settle(L, { index: at });
  }
  function setActive(layout, gid, tab) {
    const L = clone(layout),
      hit = find(L.tree, gid);
    if (!hit || hit.n.k !== 'g' || !hit.n.tabs.includes(tab)) return layout;
    hit.n.active = tab;
    L.focus = gid;
    return L;
  }
  function focusGroup(layout, gid) {
    if (!layout || layout.focus === gid || !find(layout.tree, gid)) return layout;
    return { ...layout, focus: gid };
  }
  // Ctrl+1..9: the nth pane in reading order (left to right, top to bottom).
  function focusIndex(layout, n) {
    const list = groups(layout.tree),
      g = list[n - 1];
    return g ? focusGroup(layout, g.id) : layout;
  }
  function rename(layout, from, to) {
    if (!isStr(from) || !isStr(to) || from === to) return layout;
    const L = clone(layout);
    let hit = false;
    walk(L.tree, (g) => {
      const i = g.tabs.indexOf(from);
      if (i < 0) return;
      hit = true;
      g.tabs[i] = to;
      g.tabs = dedupe(g.tabs);
      if (g.active === from) g.active = to;
    });
    return hit ? L : layout;
  }

  // ---- drop: the five VS Code zones ----------------------------------------------------------------
  // zone: left | right | top | bottom (split the pane), center (a tab in that pane, at the end), tabs (a tab at index idx).
  // tab may be a chat that is in no pane yet (a card from the list) or the DRAFT sentinel.
  function drop(layout, tab, targetId, zone, idx) {
    if (!isStr(tab)) return layout;
    const L = clone(layout),
      tgtHit = find(L.tree, targetId);
    if (!tgtHit || tgtHit.n.k !== 'g') return layout;
    const tgt = tgtHit.n,
      src = holder(L.tree, tab);
    if (zone === 'center' || zone === 'tabs') {
      if (src === tgt) {
        if (zone === 'tabs' && idx != null) {
          const o = tgt.tabs.indexOf(tab);
          tgt.tabs.splice(o, 1);
          let at = Math.max(0, Math.min(tgt.tabs.length + 1, idx));
          if (at > o) at--;
          tgt.tabs.splice(Math.min(at, tgt.tabs.length), 0, tab);
        }
      } else {
        if (src) takeOut(src, tab);
        const at = idx == null ? tgt.tabs.length : Math.max(0, Math.min(tgt.tabs.length, idx));
        tgt.tabs.splice(at, 0, tab);
      }
      tgt.active = tab;
      L.focus = tgt.id;
      return settle(L, { index: indexOfGroup(L, tgt.id) });
    }
    if (!['left', 'right', 'top', 'bottom'].includes(zone)) return layout;
    if (src === tgt && tgt.tabs.length === 1) return layout; // nothing to split off
    if (groups(L.tree).length >= MAX_GROUPS) return layout;
    if (src) takeOut(src, tab);
    const ng = group([tab], tab),
      dir = zone === 'left' || zone === 'right' ? 'row' : 'col',
      before = zone === 'left' || zone === 'top';
    const loc = find(L.tree, tgt.id),
      parent = loc.p;
    if (parent && parent.dir === dir) {
      const i = parent.ch.indexOf(tgt);
      parent.ch.splice(before ? i : i + 1, 0, ng);
      ng.f = tgt.f = (tgt.f || 1) / 2;
    } else {
      const w = split(dir, before ? [ng, tgt] : [tgt, ng]);
      w.f = tgt.f || 1;
      tgt.f = 1;
      ng.f = 1;
      if (!parent) L.tree = w;
      else parent.ch[parent.ch.indexOf(tgt)] = w;
    }
    L.focus = ng.id;
    return settle(L, { index: indexOfGroup(L, ng.id) });
  }
  // Ctrl+\ and the tab menu: split a pane. The chosen tab (default: the pane's active one) moves to the new pane; a pane
  // with only that one tab gets a New chat there instead, since a chat lives in one pane only.
  function splitGroup(layout, gid, dir, tab) {
    const hit = find(layout.tree, gid);
    if (!hit || hit.n.k !== 'g') return layout;
    const g = hit.n,
      zone = dir === 'col' ? 'bottom' : 'right',
      pick = tab && g.tabs.includes(tab) ? tab : g.active;
    if (g.tabs.length >= 2 && isStr(pick) && pick !== DRAFT) return drop(layout, pick, gid, zone);
    const bare = removeTab(layout, DRAFT) || layout;
    return drop(find(bare.tree, gid) ? bare : layout, DRAFT, gid, zone);
  }
  // Ctrl+Alt+Right / Left: move a tab to the next / previous pane (wrapping).
  function moveToNeighbour(layout, tab, dir) {
    const list = groups(layout.tree),
      src = holder(layout.tree, tab);
    if (!src || list.length < 2) return layout;
    const i = list.indexOf(list.find((g) => g.id === src.id)),
      to = list[(i + (dir < 0 ? -1 : 1) + list.length) % list.length];
    return drop(layout, tab, to.id, 'center');
  }

  // ---- geometry ---------------------------------------------------------------------------------------
  // Would a split of a pane this size leave both halves big enough?
  function canSplit(rect, zone, min) {
    const mw = (min && min.w) || MIN_W,
      mh = (min && min.h) || MIN_H;
    if (zone === 'left' || zone === 'right') return (rect.width || 0) / 2 >= mw;
    if (zone === 'top' || zone === 'bottom') return (rect.height || 0) / 2 >= mh;
    return true;
  }
  // The zone under the pointer (x, y) in a pane body rect {left, top, width, height}. A split zone that would make a pane
  // smaller than the minimum is not offered: the drop then opens a tab (center).
  function zoneAt(rect, x, y, min) {
    const w = rect.width || 1,
      h = rect.height || 1,
      rx = (x - rect.left) / w,
      ry = (y - rect.top) / h;
    const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
    let zone = 'center',
      m = EDGE;
    for (const k of ['left', 'right', 'top', 'bottom'])
      if (d[k] < m) {
        m = d[k];
        zone = k;
      }
    return canSplit(rect, zone, min) ? zone : 'center';
  }
  // The shaded area for a zone, as fractions of the pane body: {x, y, w, h}.
  function hintRect(zone) {
    switch (zone) {
      case 'left':
        return { x: 0, y: 0, w: 0.5, h: 1 };
      case 'right':
        return { x: 0.5, y: 0, w: 0.5, h: 1 };
      case 'top':
        return { x: 0, y: 0, w: 1, h: 0.5 };
      case 'bottom':
        return { x: 0, y: 0.5, w: 1, h: 0.5 };
      default:
        return { x: 0, y: 0, w: 1, h: 1 };
    }
  }
  // Where on a tab bar a dragged tab would land: the index before the first tab whose middle is right of x.
  function tabIndexAt(mids, x) {
    for (let i = 0; i < mids.length; i++) if (x < mids[i]) return i;
    return mids.length;
  }

  // ---- dividers ------------------------------------------------------------------------------------------
  // Drag the divider before child i of split `sid`: the two neighbours share `total` px; `size` is the first one's new size.
  function resize(layout, sid, i, size, total, minA, minB) {
    const hit = find(layout.tree, sid);
    if (!hit || hit.n.k !== 's' || i < 1 || i >= hit.n.ch.length) return layout;
    const a = minA == null ? 0 : minA,
      b = minB == null ? 0 : minB;
    if (!(total > a + b)) return layout;
    const L = clone(layout),
      s = find(L.tree, sid).n,
      na = s.ch[i - 1],
      nb = s.ch[i],
      fs = (na.f || 1) + (nb.f || 1);
    const p = Math.max(a, Math.min(total - b, size));
    na.f = (fs * p) / total;
    nb.f = fs - na.f;
    return L;
  }
  function evenOut(layout, sid) {
    const hit = find(layout.tree, sid);
    if (!hit || hit.n.k !== 's') return layout;
    const L = clone(layout),
      s = find(L.tree, sid).n;
    s.ch.forEach((c) => {
      c.f = 1;
    });
    return L;
  }

  // ---- keeping a layout in step with the workspace -------------------------------------------------------------
  // valid: Set of chat keys that can be open (null = unknown, keep everything). allowed: when given, tabs outside it are
  // dropped (the project's own tab list). add: chat keys to give a tab (in the focused pane) if they have none yet.
  // draft: true when the New chat view is showing: exactly one DRAFT tab, in the focused pane; false: none.
  function reconcile(layout, o) {
    const opt = o || {};
    let L = clone(layout);
    const valid = opt.valid instanceof Set ? opt.valid : null,
      allowed = opt.allowed instanceof Set ? opt.allowed : null;
    walk(L.tree, (g) => {
      g.tabs = g.tabs.filter((t) => t === DRAFT || ((!valid || valid.has(t)) && (!allowed || allowed.has(t))));
      if (!g.tabs.includes(g.active)) g.active = g.tabs[0] || '';
    });
    L = settle(L) || null;
    if (!L) return null;
    const have = new Set(tabsFlat(L));
    const fg = focused(L);
    for (const k of opt.add || []) {
      if (!isStr(k) || k === DRAFT || have.has(k) || (valid && !valid.has(k))) continue;
      fg.tabs.push(k);
      have.add(k);
    }
    if (opt.draft === true) {
      if (!have.has(DRAFT)) {
        fg.tabs.push(DRAFT);
      } else {
        const at = holder(L.tree, DRAFT);
        if (at && at.id !== fg.id) {
          takeOut(at, DRAFT);
          fg.tabs.push(DRAFT);
        }
      }
    } else if (opt.draft === false) {
      for (const g of groups(L.tree)) if (g.tabs.includes(DRAFT)) takeOut(g, DRAFT);
    }
    return settle(L, { index: indexOfGroup(L, L.focus) });
  }
  // A chat was opened: its pane takes focus and shows it; a chat in no pane joins the focused one, right of its active tab.
  // Any New chat tab is replaced by it when it sits in the same pane, else dropped.
  function openTab(layout, key) {
    if (!isStr(key)) return layout;
    const L = clone(layout),
      have = holder(L.tree, key);
    if (have) {
      have.active = key;
      L.focus = have.id;
      for (const g of groups(L.tree)) if (g.tabs.includes(DRAFT)) takeOut(g, DRAFT);
      return settle(L, { index: indexOfGroup(L, have.id) });
    }
    const fg = focused(L),
      d = fg.tabs.indexOf(DRAFT);
    if (d >= 0) fg.tabs[d] = key;
    else {
      const at = fg.tabs.indexOf(fg.active);
      fg.tabs.splice(at < 0 ? fg.tabs.length : at + 1, 0, key);
    }
    fg.active = key;
    L.focus = fg.id;
    for (const g of groups(L.tree)) if (g.tabs.includes(DRAFT)) takeOut(g, DRAFT);
    return settle(L, { index: indexOfGroup(L, fg.id) });
  }
  // The New chat view opened (from + on a pane, or Ctrl+\ on a one-tab pane): its tab sits in the focused pane, active.
  function openDraft(layout) {
    const L = clone(layout),
      fg = focused(L);
    for (const g of groups(L.tree)) if (g.tabs.includes(DRAFT)) takeOut(g, DRAFT);
    fg.tabs.push(DRAFT);
    fg.active = DRAFT;
    return settle(L, { index: indexOfGroup(L, fg.id) }) || layout;
  }
  // The pane that should be shown for a chat key that was removed from the workspace for good.
  const restoreKey = (layout) => {
    const g = focused(layout);
    return g && isStr(g.active) && g.active !== DRAFT ? g.active : '';
  };

  // ---- shape of what is saved ----------------------------------------------------------------------------
  function cleanNode(n, depth) {
    if (!n || typeof n !== 'object' || depth > 12) return null;
    const f = Number(n.f) > 0 && Number.isFinite(Number(n.f)) ? Number(n.f) : 1;
    if (n.k === 'g') {
      const tabs = dedupe(Array.isArray(n.tabs) ? n.tabs : [])
        .filter((t) => t !== DRAFT)
        .slice(0, MAX_TABS);
      if (!tabs.length) return null;
      const id = isStr(n.id) ? n.id : nextId('g');
      bump(id);
      return { k: 'g', id, tabs, active: tabs.includes(n.active) ? n.active : tabs[0], f };
    }
    if (n.k === 's' && Array.isArray(n.ch)) {
      const ch = n.ch.map((c) => cleanNode(c, depth + 1)).filter(Boolean);
      if (!ch.length) return null;
      const id = isStr(n.id) ? n.id : nextId('s');
      bump(id);
      return { k: 's', id, dir: n.dir === 'col' ? 'col' : 'row', ch, f };
    }
    return null;
  }
  function uniqueIds(tree) {
    const seen = new Set();
    const go = (n) => {
      if (seen.has(n.id)) n.id = nextId(n.k === 'g' ? 'g' : 's');
      seen.add(n.id);
      if (n.k === 's') n.ch.forEach(go);
    };
    go(tree);
  }
  // One layout from storage: valid, or null. A chat can be in one pane only: a repeated tab keeps its first place.
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let tree = cleanNode(raw.tree, 0);
    if (!tree) return null;
    uniqueIds(tree);
    const seen = new Set();
    walk(tree, (g) => {
      g.tabs = g.tabs.filter((t) => !seen.has(t) && seen.add(t));
      if (!g.tabs.includes(g.active)) g.active = g.tabs[0] || '';
    });
    tree = prune(tree);
    if (!tree || groups(tree).length < 2 || groups(tree).length > MAX_GROUPS) return null;
    const list = groups(tree);
    return { tree, focus: list.some((g) => g.id === raw.focus) ? raw.focus : list[0].id };
  }
  // The whole store: { v: 1, layouts: { projectKey | "all": layout } }
  function emptyStore() {
    return { v: 1, layouts: {} };
  }
  function sanitizeStore(raw) {
    const out = emptyStore();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.layouts || typeof raw.layouts !== 'object')
      return out;
    for (const k of Object.keys(raw.layouts).slice(0, MAX_LAYOUTS)) {
      const L = sanitize(raw.layouts[k]);
      if (L) out.layouts[k] = L;
    }
    return out;
  }
  const getLayout = (store, key) => (store && store.layouts && store.layouts[key]) || null;
  // Save (or, for a layout with fewer than two panes, forget) the layout of `key`.
  function putLayout(store, key, layout) {
    const layouts = { ...(store ? store.layouts : {}) };
    if (layout && countGroups(layout) >= 2) layouts[key] = layout;
    else delete layouts[key];
    return { v: 1, layouts };
  }
  function read(storage) {
    try {
      return sanitizeStore(JSON.parse(storage.getItem(STORE)));
    } catch (e) {
      return emptyStore();
    }
  }
  function write(storage, store) {
    try {
      storage.setItem(STORE, JSON.stringify(store));
      return true;
    } catch (e) {
      return false;
    }
  }
  // Changes when the arrangement of panes changes (not their tabs or sizes): the page rebuilds the stage on this.
  function shape(layout) {
    if (!layout) return '';
    const go = (n) => (n.k === 'g' ? n.id : n.id + n.dir + '(' + n.ch.map(go).join(',') + ')');
    return go(layout.tree) + '@' + layout.focus;
  }

  const api = {
    MIN_W,
    MIN_H,
    NARROW,
    DRAFT,
    EDGE,
    ALL,
    STORE,
    MAX_GROUPS,
    group,
    split,
    single,
    groups,
    countGroups,
    across,
    minStageWidth,
    find,
    holder,
    focused,
    tabsFlat,
    indexOfGroup,
    prune,
    removeTab,
    setActive,
    focusGroup,
    focusIndex,
    rename,
    drop,
    splitGroup,
    moveToNeighbour,
    canSplit,
    zoneAt,
    hintRect,
    tabIndexAt,
    resize,
    evenOut,
    reconcile,
    openTab,
    openDraft,
    restoreKey,
    sanitize,
    emptyStore,
    sanitizeStore,
    getLayout,
    putLayout,
    read,
    write,
    shape,
  };
  root.AgentSplitTree = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
