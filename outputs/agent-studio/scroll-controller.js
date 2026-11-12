'use strict';
/* The one owner of the scroll position of every streamed list: the main chat (#messages), the subagent view (#submessages),
   split side panes (.mirror-msgs) and command output (#commandDetails). No other code sets scrollTop on these lists
   (work/test_scroll_owner.js fails the build if one does).

   Each list holds one piece of state, plain data:
     {mode: 'follow'}                               stay at the newest row
     {mode: 'anchor', rid, off, h, w}               keep row `rid` at `off` px from the list's top (negative: it starts above the
                                                    view); h and w are the row's height and the list's width when you left it, so
                                                    a row that re-wraps after a width change keeps the line you were on
   Rows carry stable ids (data-rid, from the chat's event numbers: chat.js tagRow), and a fold that hides rows carries the range
   it covers (data-rid-from / data-rid-to), so an anchor on a hidden row finds the fold that holds it.

   Only you change the state: any movement of the list the controller did not make is yours ("anything AIB didn't move, you
   moved"). Wheel up, scroll keys and a downward touch are early signals (follow stops before the list even moves, so an update
   landing in between cannot pull you back down), and a click that opens something (a step, "Show all", a fold) anchors the row you
   clicked. Redraws, resizes, zoom, clamping, pictures loading, view switches and the controller's own writes never change it.

   Applying the state is a pure function of the state and the layout. One ResizeObserver per list (the list and each top-level
   row) calls it after layout and before paint, so the corrected position is the first one drawn; the drawing code calls
   afterRedraw() at the end of every draw. No timers and no thresholds, except "at the bottom" (1 px) for following again after
   your own scroll. (The one timer here saves the places to disk a moment after you stop scrolling.)

   API (window.ScrollController; module.exports for node tests):
     const ctl = ScrollController.attach(box, {role, clamp, onChange(next, prev, cause), nearTop: {px, fn}})
     ctl.state / ctl.following / ctl.key
     ctl.beforeRedraw()             a scroll you made that the browser has not reported yet is taken first
     ctl.afterRedraw()              end of every draw into box (clamps long blocks first when opts.clamp)
     ctl.follow(cause)              ↓ Latest, End, send
     ctl.anchorTo(el, off, cause)   the New line, a find hit (off: px from the top; null keeps it where it is); follows when that
                                    place is past the end
     ctl.anchorTop(cause)           the row at the top now ("Show earlier", "Load earlier", before the redraw)
     ctl.switchTo(key, fallback)    save the state under the current key, load key's (or fallback()); the next draw applies it
     ctl.reattached()               the list was moved in the page (split panes): its position was reset by the browser, not you
     ctl.apply() / ctl.detach()
     ScrollController.store         Map 'role:key' -> state, shared by the main list and side panes (the same chat keeps one place)
     ScrollController.configure({storage, storageKey, max})   keep the main lists' places across restarts (newest `max` chats)
     ScrollController.reattachAll() a list moved in the page (split view): each goes back to its place */
(function (root) {
  const ROLE_PREFIX = { main: 'main', mirror: 'main', sub: 'sub', command: 'command' };
  const FOLLOW = Object.freeze({ mode: 'follow' });
  const store = new Map();
  const live = new Set(); // attached controllers
  let saving = null; // {storage, storageKey, max, timer}

  /* ---- row ids: 'L:<seq>' (live events), 'T:<index>' (saved transcript), 'P:<n>' (sends not shown yet). The number orders them. */
  const kindOf = (rid) => (typeof rid === 'string' && rid.length > 2 && rid[1] === ':' ? rid[0] : '');
  function orderOf(rid) {
    const n = Number(String(rid).slice(2));
    if (!Number.isFinite(n)) return NaN;
    return kindOf(rid) === 'P' ? 1e15 + n : n;
  }

  /* ---- persistence: the main lists' places (Q7: a place survives an AIB restart and a new build folder). The value lives under a
     localStorage key that view-prefs.js copies to AIB's data folder (studio-view.json), so it is not only in this browser profile. */
  const persisted = (k) => k.startsWith('main:');
  function cleanState(s) {
    if (!s || typeof s !== 'object') return null;
    if (s.mode === 'follow') return FOLLOW;
    if (s.mode !== 'anchor' || typeof s.rid !== 'string' || !kindOf(s.rid)) return null;
    const num = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
    const fp = typeof s.fp === 'string' ? s.fp.slice(0, 60) : '';
    return { mode: 'anchor', rid: s.rid, off: num(s.off), h: num(s.h), w: num(s.w), ...(fp ? { fp } : {}), ...(Number.isFinite(s.at) && s.at > 0 ? { at: s.at } : {}) };
  }
  function configure(opts) {
    saving = { storage: opts.storage, storageKey: opts.storageKey || 'studio-scroll-v1', max: opts.max || 200, timer: 0 };
    try {
      const raw = JSON.parse(saving.storage.getItem(saving.storageKey) || '{}');
      for (const k of Object.keys(raw || {})) {
        const s = cleanState(raw[k]);
        if (s && persisted(k) && !store.has(k)) store.set(k, s);
      }
    } catch (e) {}
    const now = () => saveNow();
    if (root.addEventListener) root.addEventListener('pagehide', now);
    const d = root.document;
    if (d && d.addEventListener)
      d.addEventListener('visibilitychange', () => {
        if (d.visibilityState === 'hidden') now();
      });
  }
  function saveNow() {
    if (!saving) return;
    if (saving.timer) (root.clearTimeout || clearTimeout)(saving.timer);
    saving.timer = 0;
    const keys = [...store.keys()].filter(persisted);
    const out = {};
    for (const k of keys.slice(-saving.max)) out[k] = store.get(k);
    try {
      const text = JSON.stringify(out);
      if (saving.storage.getItem(saving.storageKey) !== text) saving.storage.setItem(saving.storageKey, text);
    } catch (e) {}
  }
  /* 1.5 s after the last change (scrolling changes the anchor on every frame; it is written once you stop). Leaving the page
     writes at once. */
  function saveSoon() {
    if (!saving) return;
    if (saving.timer) (root.clearTimeout || clearTimeout)(saving.timer);
    saving.timer = (root.setTimeout || setTimeout)(saveNow, 1500);
  }
  function remember(k, state) {
    if (!k) return;
    const prev = store.get(k);
    store.delete(k); // the newest at the end: the oldest go first when the saved list is full
    store.set(k, state);
    while (store.size > 1000) store.delete(store.keys().next().value);
    if (persisted(k) && (!prev || prev.mode !== state.mode || prev.rid !== state.rid)) saveSoon();
  }

  function attach(box, opts) {
    opts = opts || {};
    const prefix = ROLE_PREFIX[opts.role] || opts.role || 'list';
    const RO = opts.ResizeObserver || root.ResizeObserver,
      MO = opts.MutationObserver || root.MutationObserver;
    let state = FOLLOW,
      key = '',
      settled = box.scrollTop,
      lastW = box.clientWidth,
      lastH = box.clientHeight,
      lostLayout = false, // hidden or moved in the page since the last apply: the browser reset the position, not you
      restoring = false, // a place loaded by switchTo: trusted only on the same row (id and fingerprint), until it is found once
      inObserver = false,
      detached = false,
      touchY = null;
    const observed = new Set();
    const isRow = (el) => !!(el && el.dataset && (el.dataset.rid || el.dataset.ridFrom));
    const kids = () => Array.from(box.children || []);
    const boxTop = () => box.getBoundingClientRect().top;
    const drawn = (el) => !el.getClientRects || el.getClientRects().length > 0;

    function emit() {
      if (state.mode === 'anchor') box.dataset.paused = '1';
      else {
        delete box.dataset.paused;
        delete box.dataset.unseen;
      }
    }
    function set(next, cause) {
      const prev = state;
      state = next;
      if (key) remember(prefix + ':' + key, next);
      emit();
      if (prev.mode !== next.mode && opts.onChange) {
        /* from inside a ResizeObserver: the listeners' layout work (the jump button) waits for the next frame */
        if (inObserver && root.requestAnimationFrame) root.requestAnimationFrame(() => opts.onChange(next, prev, cause));
        else opts.onChange(next, prev, cause);
      }
    }
    function markSettled() {
      settled = box.scrollTop;
      lastW = box.clientWidth;
      lastH = box.clientHeight;
    }

    /* The row an anchor points at: the row itself, else the fold that holds it, else the nearest drawn row (earlier first).
       null when no drawn row has the same kind of id (a live chat that became a saved one: AIB keeps the pixel place). */
    function rowFor(rid, fp, at) {
      if (!rid) return null;
      const want = orderOf(rid),
        kind = kindOf(rid);
      let before = null,
        after = null,
        sameFp = null,
        sameAt = null;
      for (const el of kids()) {
        const d = el.dataset;
        if (d && fp && d.fp === fp && drawn(el) && (!sameFp || Math.abs(orderOf(d.rid) - want) < Math.abs(orderOf(sameFp.dataset.rid) - want)))
          sameFp = el;
        if (d && at && +d.at === at && fp && d.fp && d.fp.split(':')[0] === fp.split(':')[0] && drawn(el)) sameAt = el;
      }
      for (const el of kids()) {
        const d = el.dataset;
        if (!d) continue;
        if (d.rid === rid && drawn(el)) {
          /* a saved place: the same id on another row means the ids were given again (a new connection numbers from 1) */
          if (!restoring || !fp || !d.fp || d.fp === fp) return { el, exact: true };
          break;
        }
        if (d.ridFrom && kindOf(d.ridFrom) === kind) {
          const a = orderOf(d.ridFrom),
            b = orderOf(d.ridTo || d.ridFrom);
          if (want >= a && want <= b && drawn(el)) return { el, exact: false };
        }
        const r = d.rid || d.ridFrom;
        if (!r || kindOf(r) !== kind || !drawn(el)) continue;
        const o = orderOf(r);
        if (o <= want) before = el;
        else if (!after) after = el;
      }
      /* the row under another id: the same fingerprint, else the same time and role (replayed rows have no time) */
      if (sameFp) return { el: sameFp, exact: true };
      if (sameAt) return { el: sameAt, exact: true };
      if (restoring) return null; // a saved place is only trusted on its own row
      const el = before || after;
      return el ? { el, exact: false } : null;
    }
    const ridOf = (el) => el.dataset.rid || el.dataset.ridFrom;
    /* What an anchor remembers of its row besides the id: its fingerprint and time (chat.js tagRow), for a row whose id changed
       (a live chat read back from its saved transcript, a connection that numbers its events again). */
    function placeOf(el, off, h) {
      const d = el.dataset,
        out = { mode: 'anchor', rid: ridOf(el), off, h, w: box.clientWidth };
      if (d.fp) out.fp = d.fp;
      if (d.at && +d.at > 0) out.at = +d.at;
      return out;
    }

    /* The row at the top of the view now (the first row whose bottom is inside it), found by a binary search over the rows. */
    function anchorAtTop() {
      const rows = kids().filter(isRow);
      if (!rows.length) return { mode: 'anchor', rid: '', off: 0, h: 0, w: box.clientWidth, top: box.scrollTop };
      const top = boxTop();
      let lo = 0,
        hi = rows.length - 1,
        found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1,
          r = rows[mid].getBoundingClientRect();
        if (r.bottom > top + 1) {
          found = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      let i = found < 0 ? rows.length - 1 : found;
      while (i < rows.length - 1 && !drawn(rows[i])) i++; // a fold's hidden rows have no box
      const el = rows[i],
        r = el.getBoundingClientRect();
      return placeOf(el, r.top - top, r.height);
    }

    function apply() {
      if (detached) return;
      if (box.isConnected === false) return;
      if (!box.clientHeight) {
        // hidden: kept, applied when it shows (the observer fires). Without an observer (node tests) nothing would re-apply it.
        lostLayout = !!ro;
        if (!ro) markSettled();
        return;
      }
      if (lostLayout) {
        lostLayout = false;
        markSettled();
      } else takePending(true);
      const max = box.scrollHeight - box.clientHeight;
      let target;
      if (state.mode === 'follow') target = max;
      else if (!state.rid) target = Number.isFinite(state.top) ? state.top : box.scrollTop;
      else {
        const hit = rowFor(state.rid, state.fp, state.at);
        if (!hit) {
          /* Rows are drawn and none is this place's row. A place loaded for a chat you open: the opening rule (onLost 'restore':
             the New line, else the end). A row that went while you read (a live chat read back from its saved transcript): you
             stay where you are, nothing is marked read. */
          const wasRestoring = restoring;
          if (kids().some(isRow)) restoring = false;
          if (wasRestoring && kids().some(isRow) && opts.onLost) opts.onLost(state, 'restore');
          markSettled();
          return;
        }
        restoring = false;
        if (hit.exact && ridOf(hit.el) !== state.rid) {
          /* found under another id (by its fingerprint or time): the place takes the row's id now; not a change of yours */
          state = { ...state, rid: ridOf(hit.el) };
          if (key) remember(prefix + ':' + key, state);
        }
        if (max <= 0 && hit.exact) {
          set(FOLLOW, 'fits'); // nothing to scroll and the row is drawn: there is no place to keep
          target = 0;
        } else {
          const r = hit.el.getBoundingClientRect();
          const want =
            hit.exact && state.off < 0 && state.h > 0 && state.w && state.w !== box.clientWidth
              ? (state.off * r.height) / state.h
              : state.off;
          target = box.scrollTop + (r.top - boxTop()) - want;
        }
      }
      target = Math.max(0, Math.min(Math.max(0, max), target));
      if (Math.abs(box.scrollTop - target) > 0.5) box.scrollTop = state.mode === 'follow' ? box.scrollHeight : target;
      markSettled(); // read back after the write: rounding at 125 % / 150 % zoom is the browser's, not a scroll of yours
    }

    /* A movement the controller did not make. From apply (`layout`): a list that changed size or got shorter under the reader moved
       because of the layout (zoom, a clamp at the end), not because of you; anything else is a scroll the browser has not reported yet. */
    function takePending(layout) {
      if (lostLayout || Math.abs(box.scrollTop - settled) <= 1) return false;
      if (layout) {
        const max = box.scrollHeight - box.clientHeight,
          resized = box.clientWidth !== lastW || box.clientHeight !== lastH,
          clamped = settled > max && box.scrollTop >= max - 1;
        if (resized || clamped) return false;
      }
      userScrolled();
      return true;
    }
    function userScrolled() {
      settled = box.scrollTop;
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      set(gap <= 1 ? FOLLOW : anchorAtTop(), 'user');
      if (opts.nearTop && box.scrollTop < opts.nearTop.px) opts.nearTop.fn();
    }
    function onScroll() {
      if (detached || lostLayout) return;
      if (Math.abs(box.scrollTop - settled) <= 1) return; // ours, or the browser re-stating ours after rounding
      userScrolled();
    }
    /* Early signals: follow stops before the list moves (a smooth scroll moves it over the next frames). */
    const scrollable = () => box.scrollHeight - box.clientHeight > 1;
    function earlyUp() {
      if (state.mode === 'follow' && scrollable()) set(anchorAtTop(), 'user');
    }
    function onWheel(e) {
      if (e.deltaY >= 0 || e.ctrlKey) return; // Ctrl+wheel and a touchpad pinch zoom the text, they do not scroll
      for (let n = e.target; n && n !== box && n.nodeType === 1; n = n.parentElement) {
        /* a box inside the list (a wide table, a code block) that can still scroll up takes this wheel itself */
        if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight + 1 && root.getComputedStyle) {
          const oy = root.getComputedStyle(n).overflowY;
          if (oy === 'auto' || oy === 'scroll') return;
        }
      }
      earlyUp();
    }
    function onKey(e) {
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) || (e.key === ' ' && e.shiftKey)) earlyUp();
    }
    function onTouchStart(e) {
      touchY = e.touches && e.touches[0] ? e.touches[0].clientY : null;
    }
    function onTouchMove(e) {
      const y = e.touches && e.touches[0] ? e.touches[0].clientY : null;
      if (touchY != null && y != null && y > touchY) earlyUp();
    }
    /* Opening something you clicked (a closed step, "Show all", a fold, Thoughts): that row stays where you clicked it.
       Taken in capture, before the toggle runs, so the offset is the one before it opened. Closing changes nothing, nor do
       other buttons (Open doc, links). */
    function onClickCapture(e) {
      if (state.mode !== 'follow') return;
      const t = e.target;
      if (!t || !t.closest) return;
      const ctl = t.closest('[aria-expanded], summary, .clamp-toggle');
      if (!ctl || !box.contains(ctl)) return;
      if (ctl.getAttribute && ctl.getAttribute('aria-haspopup')) return; // a menu floats over the list (Copy as...): nothing opens in it
      const closed =
        ctl.tagName === 'SUMMARY'
          ? !(ctl.parentElement && ctl.parentElement.open)
          : ctl.getAttribute('aria-expanded') === 'false';
      if (!closed) return;
      let row = ctl;
      while (row && row.parentElement !== box) row = row.parentElement;
      if (!row) return;
      anchorTo(row, null, 'open');
    }

    function anchorTo(el, off, cause) {
      if (!el) return follow(cause);
      if (lostLayout || !box.clientHeight) {
        if (isRow(el)) set({ mode: 'anchor', rid: ridOf(el), off: off || 0, h: 0, w: 0 }, cause);
        return;
      }
      const top = boxTop(),
        r = el.getBoundingClientRect();
      if (off == null && isRow(el)) {
        settled = box.scrollTop;
        set(placeOf(el, r.top - top, r.height), cause);
        return;
      }
      const max = box.scrollHeight - box.clientHeight,
        t = box.scrollTop + (r.top - top) - (off || 0);
      if (t >= max - 1) return follow(cause); // that place is past the end: you are at the newest row
      box.scrollTop = Math.max(0, t);
      markSettled();
      set(isRow(el) ? placeOf(el, el.getBoundingClientRect().top - boxTop(), r.height) : anchorAtTop(), cause);
    }
    function follow(cause) {
      set(FOLLOW, cause || 'follow');
      apply();
    }
    function anchorTop(cause) {
      if (!box.clientHeight) return;
      takePending(false);
      set(anchorAtTop(), cause);
    }
    function switchTo(next, fallback) {
      if (key) remember(prefix + ':' + key, state);
      key = String(next || '');
      const saved = key ? store.get(prefix + ':' + key) : null;
      const s = saved || (fallback ? fallback() : null) || FOLLOW;
      lostLayout = true; // the list is redrawn for another chat: its position now is not something you did
      restoring = s.mode === 'anchor';
      set(s, 'switch');
      if (saving && persisted(prefix + ':' + key)) saveNow();
      /* applied by the drawer's afterRedraw once the new rows are drawn (the rows still in the list belong to the last key) */
    }

    /* ---- the watcher ---- */
    let ro = null,
      mo = null;
    if (typeof RO === 'function') {
      ro = new RO((entries) => {
        for (const e of entries)
          if (e.target === box && e.contentRect && !e.contentRect.height && !e.contentRect.width) lostLayout = true;
        inObserver = true;
        try {
          apply();
        } finally {
          inObserver = false;
        }
      });
      ro.observe(box);
    }
    const watch = (el) => {
      if (!ro || observed.has(el) || el.nodeType !== 1) return;
      observed.add(el);
      ro.observe(el);
    };
    const unwatch = (el) => {
      if (!ro || !observed.has(el)) return;
      observed.delete(el);
      ro.unobserve(el);
    };
    kids().forEach(watch);
    if (typeof MO === 'function') {
      mo = new MO((records) => {
        let removed = false;
        for (const rec of records) {
          for (const n of rec.addedNodes || []) if (n.parentNode === box) watch(n);
          for (const n of rec.removedNodes || [])
            if (n.parentNode !== box) {
              unwatch(n);
              removed = true;
            }
        }
        if (removed) apply(); // rows taken out make the list shorter without resizing any watched row
      });
      mo.observe(box, { childList: true });
    }
    const listen = (t, fn, o) => box.addEventListener && box.addEventListener(t, fn, o);
    listen('scroll', onScroll, { passive: true });
    listen('wheel', onWheel, { passive: true });
    listen('keydown', onKey);
    listen('touchstart', onTouchStart, { passive: true });
    listen('touchmove', onTouchMove, { passive: true });
    listen('click', onClickCapture, true);
    if (box.classList) box.classList.add('scroll-list');

    const ctl = {
      get state() {
        return state;
      },
      get following() {
        return state.mode === 'follow';
      },
      get key() {
        return key;
      },
      box,
      apply,
      beforeRedraw() {
        if (!detached && box.clientHeight && !lostLayout) takePending(true);
      },
      /* A place set by the page, not by you (a lost place handed to the opening rule): listeners see cause 'switch'. */
      replace(next) {
        restoring = false;
        set(next, 'switch');
        apply();
      },
      afterRedraw() {
        if (detached) return;
        if (opts.clamp && root.ClampUI && root.ClampUI.apply) root.ClampUI.apply(box);
        apply();
      },
      follow,
      anchorTo,
      anchorTop,
      switchTo,
      reattached() {
        lostLayout = true;
        apply();
      },
      /* The index of the anchored row in `rids` (the ids of every row the list could draw, in order), so the drawing code can
         widen its window to keep that row drawn; -1 when following or not found. */
      anchorIndex(rids) {
        if (state.mode !== 'anchor' || !state.rid) return -1;
        const i = rids.indexOf(state.rid);
        if (i >= 0) return i;
        const want = orderOf(state.rid),
          kind = kindOf(state.rid);
        let best = -1;
        rids.forEach((r, j) => {
          if (kindOf(r) === kind && orderOf(r) <= want) best = j;
        });
        return best;
      },
      detach() {
        detached = true;
        live.delete(ctl);
        if (ro) ro.disconnect();
        if (mo) mo.disconnect();
        const off = (t, fn, o) => box.removeEventListener && box.removeEventListener(t, fn, o);
        off('scroll', onScroll, { passive: true });
        off('wheel', onWheel, { passive: true });
        off('keydown', onKey);
        off('touchstart', onTouchStart, { passive: true });
        off('touchmove', onTouchMove, { passive: true });
        off('click', onClickCapture, true);
      },
      _set: set, // tests
    };
    live.add(ctl);
    emit();
    return ctl;
  }

  /* Every attached list that is in the page: put back at its place (split-ui.js moved lists around; the browser reset them). */
  function reattachAll() {
    for (const c of Array.from(live)) if (c.box.isConnected !== false) c.reattached();
  }
  const api = { attach, store, configure, saveNow, orderOf, kindOf, FOLLOW, live, reattachAll };
  root.ScrollController = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
