'use strict';
/* Resizable layout: chat list (right edge), Activity column (left edge), message box (top edge), Subagents/Processes split.
   VS Code behaviour: thin handles that light up on hover and drag, snap-to-collapse 40 px below a panel's minimum, double-click
   or Enter resets, arrow keys / Home / End on focused handles, Ctrl+B (chat list) and Ctrl+Alt+B (Activity). Sizes are kept in
   localStorage per window-width bucket. The pure helpers at the top have node tests; the DOM part starts at init(). */
(function (root) {
  const DEF = { side: 240, activity: 280 },
    SIDE = { min: 200, max: 480 }, // a wider chat list only takes room from the chat (QA m13)
    ACT = { min: 220, max: Infinity },
    COMPOSER_MIN = 56,
    COMPOSER_GROW = 200,
    SPLIT_MIN = 96;
  const MIN_CHAT = 420,
    SNAP = 40,
    STEP = 16,
    BIG_STEP = 64,
    NARROW = 1100,
    SUBCHAT_W = 480,
    EXPAND_FRAC = 0.6;
  const num = (v) => typeof v === 'number' && isFinite(v);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  /* localStorage key suffix: laptop and big-monitor layouts are remembered separately. */
  function bucketKey(width) {
    const w = Number(width);
    return w < 1400 ? '<1400' : w < 1800 ? '<1800' : '>=1800';
  }
  /* Largest width a side panel may have so the chat column keeps MIN_CHAT next to the other panel (which counts as `other` px). */
  /* `scale` is the interface size (1 = 100 %): default widths and limits grow with it, so the zoomed text keeps its room. */
  const sc = (v, scale) => (scale && scale !== 1 ? Math.round(v * scale) : v);
  /* `minChat`: the chat column's floor when it is more than MIN_CHAT (split panes side by side each need their own room). */
  const chatFloor = (minChat) => Math.max(MIN_CHAT, num(minChat) ? minChat : 0);
  function maxSide(vw, other, scale, minChat) {
    return clamp(vw - (other || 0) - chatFloor(minChat), sc(SIDE.min, scale), sc(SIDE.max, scale));
  }
  function maxActivity(vw, other, scale, minChat) {
    return clamp(vw - (other || 0) - chatFloor(minChat), sc(ACT.min, scale), sc(ACT.max, scale));
  }
  /* Dragging: `raw` is where the edge would be. Past (min - SNAP) the panel collapses; between that and min it stays at min. */
  function dragResult(raw, min, max, collapsible) {
    if (!num(raw)) return { collapsed: false, size: min };
    if (collapsible && raw < min - SNAP) return { collapsed: true, size: min };
    return { collapsed: false, size: Math.round(clamp(raw, min, max)) };
  }
  /* Keyboard on a focused handle. `inverted` means the handle moves the edge the other way (Activity's left edge, the message
   box's top edge: ArrowLeft/ArrowUp grow them). Returns the new size, or null when the key does nothing. */
  function keyStep(key, o) {
    const { value, min, max, def, shift, inverted, axis } = o,
      step = shift ? BIG_STEP : STEP;
    if (key === 'Home') return min;
    if (key === 'End') return max;
    if (key === 'Enter') return def;
    const fwd = axis === 'y' ? 'ArrowDown' : 'ArrowRight',
      back = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
    if (key !== fwd && key !== back) return null;
    const sign = (key === fwd ? 1 : -1) * (inverted ? -1 : 1);
    return Math.round(clamp((num(value) ? value : def) + sign * step, min, max));
  }
  /* Effective widths. sizes may be null (default). Side panels give way before the chat column drops below MIN_CHAT; when a
   subagent history is open Activity widens to max(its width, 480) as far as the room allows. */
  function computeLayout(o) {
    const vw = Number(o.vw) || 0,
      sideOn = !!o.sideOn,
      actOn = !!o.actOn,
      k = o.scale || 1,
      minChat = chatFloor(o.minChat);
    const sMin = sc(SIDE.min, k),
      sMax = sc(SIDE.max, k),
      aMin = sc(ACT.min, k),
      aMax = sc(ACT.max, k);
    let side = sideOn ? clamp(num(o.side) ? o.side : sc(DEF.side, k), sMin, sMax) : 0;
    const user = clamp(num(o.activity) ? o.activity : sc(DEF.activity, k), aMin, aMax);
    let act = actOn ? user : 0;
    const over = side + act + minChat - vw;
    if (over > 0) {
      const ss = sideOn ? side - sMin : 0,
        sa = actOn ? act - aMin : 0,
        tot = ss + sa,
        take = Math.min(over, tot);
      if (tot > 0) {
        const fromSide = Math.round((take * ss) / tot);
        side -= fromSide;
        act -= take - fromSide;
      }
    }
    if (o.subchat && actOn) {
      const room = Math.max(0, vw - side - minChat),
        want = Math.min(aMax, Math.max(user, sc(SUBCHAT_W, k)));
      act = Math.max(act, Math.min(want, room));
    }
    /* Changes expanded (the tab row's widen button): about 60% of the window, as far as the chat keeps its minimum. */
    if (o.expand && actOn) {
      const room = Math.max(0, vw - side - minChat);
      act = Math.max(act, Math.min(Math.round(vw * EXPAND_FRAC), room));
    }
    return { side, activity: act };
  }
  /* Message box: floor is today's 56 px; it can grow until about 200 px of the window are left. Typing grows the box up to growCap. */
  /* No fixed ceiling: the box may grow until the header and a strip of messages (about 200 px) are left. */
  const composerMax = (vh) => Math.max(COMPOSER_MIN, Math.floor((Number(vh) || 0) - 200));
  const clampComposer = (h, vh) => Math.round(clamp(h, COMPOSER_MIN, composerMax(vh)));
  const growCap = (userH, vh) => clamp(Math.max(COMPOSER_GROW, num(userH) ? userH : 0), COMPOSER_MIN, composerMax(vh));
  /* Subagents/Processes split: each keeps SPLIT_MIN of the `total` px they share. */
  const splitBounds = (total) => ({ min: SPLIT_MIN, max: Math.max(SPLIT_MIN, Math.floor(total) - SPLIT_MIN) });
  const clampSplit = (h, total) => {
    const b = splitBounds(total);
    return Math.round(clamp(h, b.min, b.max));
  };
  /* Stored sizes: only finite numbers survive; anything else means "default". */
  function sanitize(raw) {
    let o = raw;
    if (typeof raw === 'string') {
      try {
        o = JSON.parse(raw);
      } catch (e) {
        o = null;
      }
    }
    o = o && typeof o === 'object' ? o : {};
    const pick = (k) => (num(o[k]) && o[k] > 0 ? Math.round(o[k]) : null);
    return { side: pick('side'), activity: pick('activity'), composer: pick('composer'), split: pick('split') };
  }
  const storageKey = (width) => 'studio-layout-v1:' + bucketKey(width);
  const pure = {
    sc,
    DEF,
    SIDE,
    ACT,
    COMPOSER_MIN,
    SPLIT_MIN,
    MIN_CHAT,
    SNAP,
    STEP,
    BIG_STEP,
    NARROW,
    clamp,
    bucketKey,
    storageKey,
    maxSide,
    maxActivity,
    dragResult,
    keyStep,
    computeLayout,
    composerMax,
    clampComposer,
    growCap,
    splitBounds,
    clampSplit,
    sanitize,
  };

  const SIDE_KEY = 'studio-side-hidden';
  let api = pure,
    live = null;
  function init(win) {
    win = win || root;
    const doc = win.document,
      body = doc.body,
      rootEl = doc.documentElement;
    if (!body || body.dataset.resizeUi) return;
    body.dataset.resizeUi = '1';
    const store = () => {
      try {
        return win.localStorage;
      } catch (e) {
        return null;
      }
    };
    const read = (k) => {
      try {
        return store() && store().getItem(k);
      } catch (e) {
        return null;
      }
    };
    const write = (k, v) => {
      try {
        store() && store().setItem(k, v);
      } catch (e) {}
    };
    const $ = (id) => doc.getElementById(id);
    const reduced = () => {
      try {
        return win.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) {
        return false;
      }
    };
    let bucket = bucketKey(win.innerWidth),
      sizes = sanitize(read(storageKey(win.innerWidth)));
    let sideHidden = read(SIDE_KEY) === '1';
    let eff = { side: 0, activity: 0 };
    const wideSide = () => win.innerWidth > NARROW,
      wideAct = () => win.innerWidth >= NARROW;
    const AUI = () => win.ActivityUI;
    /* Interface size and chat text size as multipliers (1 when textsize-ui.js is absent or at 100 %). */
    const pctOf = (n) => {
      try {
        const v = win.AgentTextSize && win.AgentTextSize[n]();
        return v > 0 ? v / 100 : 1;
      } catch (e) {
        return 1;
      }
    };
    const uiK = () => pctOf('getUi'),
      chatK = () => pctOf('getChat');
    const actHidden = () => {
      try {
        return !!(AUI() && AUI().readHidden());
      } catch (e) {
        return false;
      }
    };
    const save = () => write(storageKey(win.innerWidth), JSON.stringify(sizes));
    const setSideHidden = (v) => {
      v = !!v;
      if (v === sideHidden) return;
      sideHidden = v;
      write(SIDE_KEY, v ? '1' : '0');
    };
    const setActHidden = (v) => {
      v = !!v;
      if (v === actHidden() || !AUI()) return;
      AUI().setHidden(v);
    };

    function layout() {
      const vw = win.innerWidth,
        sideOn = wideSide() && !sideHidden,
        actOn = wideAct() && !actHidden();
      const k = uiK();
      eff = computeLayout({
        vw,
        side: sizes.side,
        activity: sizes.activity,
        sideOn,
        actOn,
        subchat: body.classList.contains('subchat-open'),
        expand: body.classList.contains('changes-wide'),
        scale: k,
        minChat: splitFloor(),
      });
      const set = (k, v) => {
        if (rootEl.style.getPropertyValue(k) !== v) rootEl.style.setProperty(k, v);
      };
      set('--side-w', eff.side + 'px');
      set('--activity-w', (actOn ? eff.activity : sizes.activity || sc(DEF.activity, k)) + 'px');
      body.classList.toggle('side-off', wideSide() && sideHidden);
      const vh = win.innerHeight / chatK(),
        ch = num(sizes.composer) ? clampComposer(sizes.composer, vh) : null;
      if (ch) set('--composer-h', ch + 'px');
      else rootEl.style.removeProperty('--composer-h');
      const prompt = $('prompt');
      if (prompt && prompt.style) {
        if (ch && dragging && dragging.id === 'composer') prompt.style.height = ch + 'px';
      }
      if (num(sizes.split) && splitTotal() > 0) {
        set('--act-split', clampSplit(sizes.split, splitTotal()) + 'px');
        body.classList.toggle('act-split-set', true);
      } else {
        rootEl.style.removeProperty('--act-split');
        body.classList.toggle('act-split-set', false);
      }
      syncHandles();
    }
    /* Split panes side by side: the chat column keeps room for every pane across (split-ui.js says how much). */
    function splitFloor() {
      try {
        const S = win.AgentSplitUI;
        return S && typeof S.minWidth === 'function' ? Number(S.minWidth()) || 0 : 0;
      } catch (e) {
        return 0;
      }
    }
    function splitTotal() {
      const a = $('subagentList'),
        c = $('commandSection');
      return a && c && a.offsetParent !== null ? a.offsetHeight + c.offsetHeight : 0;
    }

    /* ---- handles ----------------------------------------------------------------------------------------------- */
    const handles = {};
    function make(id, cls, label, orientation, parent) {
      const h = doc.createElement('div');
      h.id = 'rs-' + id;
      h.className = 'rs-handle ' + cls;
      h.setAttribute('role', 'separator');
      h.setAttribute('aria-orientation', orientation);
      h.setAttribute('aria-label', label);
      h.tabIndex = 0;
      h.title = label + ' (double-click to reset)';
      (parent || body).append(h);
      handles[id] = h;
      return h;
    }
    const defs = {
      side: {
        label: 'Resize chat list',
        orientation: 'vertical',
        axis: 'x',
        inverted: false,
        collapsible: true,
        get def() {
          return sc(DEF.side, uiK());
        },
        min: () => sc(SIDE.min, uiK()),
        max: () => maxSide(win.innerWidth, eff.activity, uiK(), splitFloor()),
        value: () => (sideHidden ? 0 : eff.side),
        rawFrom: (e, g) => e.clientX - g,
        grab: (e) => e.clientX - (sideHidden ? 0 : eff.side),
        apply(r) {
          if (r.collapsed) {
            setSideHidden(true);
          } else {
            setSideHidden(false);
            sizes.side = r.size;
          }
        },
        reset() {
          setSideHidden(false);
          sizes.side = null;
        },
        toggle: () => setSideHidden(!sideHidden),
        available: wideSide,
      },
      activity: {
        label: 'Resize Activity',
        orientation: 'vertical',
        axis: 'x',
        inverted: true,
        collapsible: true,
        get def() {
          return sc(DEF.activity, uiK());
        },
        min: () => sc(ACT.min, uiK()),
        max: () => maxActivity(win.innerWidth, eff.side, uiK(), splitFloor()),
        value: () => (actHidden() ? 0 : eff.activity),
        rawFrom: (e, g) => win.innerWidth - e.clientX - g,
        grab: (e) => win.innerWidth - e.clientX - (actHidden() ? 0 : eff.activity) + 0,
        apply(r) {
          if (r.collapsed) setActHidden(true);
          else {
            setActHidden(false);
            sizes.activity = r.size;
          }
        },
        reset() {
          setActHidden(false);
          sizes.activity = null;
        },
        toggle: () => setActHidden(!actHidden()),
        available: () => wideAct() && (!actHidden() || !!(dragging && dragging.id === 'activity')),
      },
      composer: {
        label: 'Resize message box',
        orientation: 'horizontal',
        axis: 'y',
        inverted: true,
        collapsible: false,
        def: COMPOSER_MIN,
        min: () => COMPOSER_MIN,
        max: () => composerMax(win.innerHeight / chatK()),
        value: () => {
          const p = $('prompt');
          return p ? Math.round(p.getBoundingClientRect().height / chatK()) : COMPOSER_MIN;
        },
        rawFrom: (e, g, start) => start.value + (start.y - e.clientY) / chatK(),
        grab: () => 0,
        apply(r) {
          sizes.composer = r.size;
          const p = $('prompt');
          if (p && p.style) p.style.height = r.size + 'px';
        },
        reset() {
          sizes.composer = null;
          const p = $('prompt');
          if (p && p.style) p.style.height = '';
        },
        available: () => true,
      },
      split: {
        label: 'Resize Subagents and Processes',
        orientation: 'horizontal',
        axis: 'y',
        inverted: false,
        collapsible: false,
        def: null,
        min: () => SPLIT_MIN,
        max: () => splitBounds(splitTotal()).max,
        value: () => {
          const a = $('subagentList');
          return a ? a.offsetHeight : 0;
        },
        rawFrom: (e, g, start) => start.value + (e.clientY - start.y) / uiK(),
        grab: () => 0,
        apply(r) {
          sizes.split = r.size;
        },
        reset() {
          sizes.split = null;
        },
        available: () => wideAct() && !actHidden() && !body.classList.contains('subchat-open') && splitTotal() > 0,
      },
    };
    /* After a reset the message box goes back to fitting its text. workspace-ui listens to "input" for that. */
    function regrow() {
      const p = $('prompt');
      if (p) p.dispatchEvent(new win.Event('input'));
    }
    function syncHandles() {
      const vw = win.innerWidth;
      for (const id in defs) {
        const h = handles[id],
          d = defs[id];
        if (!h) continue;
        const on = d.available();
        h.hidden = !on;
        if (!on) continue;
        const min = d.min(),
          max = d.max(),
          v = d.value();
        h.setAttribute('aria-valuemin', String(min));
        h.setAttribute('aria-valuemax', String(max));
        h.setAttribute('aria-valuenow', String(Math.round(v)));
        h.classList.toggle('rs-collapsed', (id === 'side' && sideHidden) || (id === 'activity' && actHidden()));
      }
      void vw;
    }

    /* ---- dragging ---------------------------------------------------------------------------------------------- */
    let dragging = null;
    function snapshot() {
      return { sizes: { ...sizes }, side: sideHidden, act: actHidden() };
    }
    function restore(s) {
      sizes = { ...s.sizes };
      setSideHidden(s.side);
      setActHidden(s.act);
      const p = $('prompt');
      if (p && p.style && s.sizes.composer == null) p.style.height = '';
    }
    function startDrag(id, e) {
      const d = defs[id];
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const h = handles[id];
      try {
        h.setPointerCapture(e.pointerId);
      } catch (err) {}
      dragging = {
        id,
        pointerId: e.pointerId,
        snap: snapshot(),
        start: { y: e.clientY, value: d.value() },
        grab: d.grab(e),
      };
      body.classList.add('rs-dragging');
      body.dataset.rsAxis = d.axis;
      h.classList.add('rs-active');
    }
    function moveDrag(e) {
      if (!dragging || e.pointerId !== dragging.pointerId) return;
      const d = defs[dragging.id],
        raw = d.rawFrom(e, dragging.grab, dragging.start);
      d.apply(dragResult(raw, d.min(), d.max(), d.collapsible));
      layout();
    }
    function endDrag(cancel) {
      if (!dragging) return;
      const id = dragging.id,
        h = handles[id];
      if (cancel) restore(dragging.snap);
      else {
        save();
      }
      try {
        h.releasePointerCapture(dragging.pointerId);
      } catch (err) {}
      h.classList.remove('rs-active');
      body.classList.remove('rs-dragging');
      delete body.dataset.rsAxis;
      dragging = null;
      layout();
      if (cancel && id === 'composer') regrow();
    }
    function onKey(id, e) {
      const d = defs[id];
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const collapsed = id === 'side' ? sideHidden : id === 'activity' ? actHidden() : false;
      if (e.key === 'Enter') {
        e.preventDefault();
        doReset(id);
        return;
      }
      const value = collapsed ? 0 : d.value();
      let next = keyStep(e.key, {
        value,
        min: d.min(),
        max: d.max(),
        def: d.def == null ? value : d.def,
        shift: e.shiftKey,
        inverted: d.inverted,
        axis: d.axis,
      });
      if (next == null) return;
      e.preventDefault();
      if (collapsed && e.key === 'Home') {
        next = d.min();
      }
      d.apply({ collapsed: false, size: next });
      save();
      layout();
    }
    function doReset(id) {
      defs[id].reset();
      save();
      layout();
      if (id === 'composer') regrow();
    }
    function wire(id, h) {
      h.addEventListener('pointerdown', (e) => startDrag(id, e));
      h.addEventListener('pointermove', moveDrag);
      h.addEventListener('pointerup', (e) => {
        if (dragging && e.pointerId === dragging.pointerId) endDrag(false);
      });
      h.addEventListener('pointercancel', () => endDrag(true));
      h.addEventListener('lostpointercapture', () => {
        if (dragging && dragging.id === id) endDrag(false);
      });
      h.addEventListener('dblclick', (e) => {
        e.preventDefault();
        doReset(id);
      });
      h.addEventListener('keydown', (e) => onKey(id, e));
    }

    /* ---- mount ------------------------------------------------------------------------------------------------- */
    function mount() {
      wire('side', make('side', 'rs-v rs-side', defs.side.label, 'vertical'));
      wire('activity', make('activity', 'rs-v rs-activity', defs.activity.label, 'vertical'));
      const form = $('promptForm');
      if (form) wire('composer', make('composer', 'rs-h rs-composer', defs.composer.label, 'horizontal', form));
      const list = $('subagentList'),
        cmd = $('commandSection');
      if (list && cmd && cmd.parentNode)
        wire('split', make('split', 'rs-h rs-split', defs.split.label, 'horizontal', cmd.parentNode));
      for (const id in handles) handles[id].hidden = true;
    }
    function onResize() {
      const b = bucketKey(win.innerWidth);
      let changed = false;
      if (b !== bucket) {
        bucket = b;
        sizes = sanitize(read(storageKey(win.innerWidth)));
        const p = $('prompt');
        if (p && p.style) p.style.height = '';
        changed = true;
      }
      layout();
      if (changed) regrow();
    }
    function toggleSide() {
      if (wideSide()) {
        setSideHidden(!sideHidden);
        layout();
        return true;
      }
      const t = doc.querySelector('.ws-list-toggle');
      if (t) {
        t.click();
        return true;
      }
      return false;
    }
    function toggleActivity() {
      if (wideAct()) {
        setActHidden(!actHidden());
        layout();
        return true;
      }
      const s = $('activityStrip');
      if (s) {
        s.click();
        return true;
      }
      return false;
    }
    function onKeydown(e) {
      if (e.defaultPrevented || e.metaKey || e.shiftKey) return;
      const key = String(e.key).toLowerCase(),
        isB = key === 'b' || e.code === 'KeyB';
      if (isB && e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleSide();
        return;
      }
      if (isB && e.ctrlKey && e.altKey) {
        e.preventDefault();
        toggleActivity();
        return;
      }
      if (e.ctrlKey && !e.altKey && key === 'p' && wideSide() && sideHidden) {
        setSideHidden(false);
        layout();
      }
    }
    function onEscape(e) {
      if (e.key === 'Escape' && dragging) {
        e.preventDefault();
        endDrag(true);
      }
    }
    /* The hamburger in the tab strip re-opens a hidden list on wide screens (it is a slide-over toggle below 1100 px). */
    function onClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('.ws-list-toggle') : null;
      if (t && wideSide()) {
        e.stopPropagation();
        e.preventDefault();
        toggleSide();
      }
    }
    live = { onKeydown, onEscape, onClick, toggleSide, toggleActivity };
    win.addEventListener('resize', onResize);
    if (typeof win.MutationObserver === 'function')
      new win.MutationObserver(layout).observe(body, { attributes: true, attributeFilter: ['class'] });
    mount();
    if (win.AgentTextSize && typeof win.AgentTextSize.onChange === 'function')
      win.AgentTextSize.onChange(() => layout());
    api.layout = layout;
    api.toggleSide = toggleSide;
    api.toggleActivity = toggleActivity;
    api.reduced = reduced;
    layout();
    /* The Subagents list is filled in after load; re-check the split handle once things settle. */
    win.setTimeout(layout, 400);
  }
  api = Object.assign({}, pure, {
    init,
    growCap: (userH, vh) => growCap(userH, vh),
    /* workspace-ui's autosize asks for the current ceiling */
    composerCap(win) {
      win = win || root;
      try {
        const v = parseFloat(win.document.documentElement.style.getPropertyValue('--composer-h'));
        return growCap(isNaN(v) ? null : v, win.innerHeight);
      } catch (e) {
        return COMPOSER_GROW;
      }
    },
  });
  root.ResizeUI = api;
  /* The Ctrl+K command bar calls these two by name. */
  root.AgentResizeUI = {
    toggleSide: () => (live ? live.toggleSide() : false),
    toggleActivity: () => (live ? live.toggleActivity() : false),
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && root === (typeof window !== 'undefined' ? window : null)) {
    /* Shortcuts are registered now (capture phase, ahead of workspace-ui's handlers); the layout is built once every script has loaded. */
    document.addEventListener(
      'keydown',
      (e) => {
        if (live) {
          live.onEscape(e);
          live.onKeydown(e);
        }
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        if (live) live.onClick(e);
      },
      true,
    );
    if (document.readyState === 'complete') init(root);
    else document.addEventListener('DOMContentLoaded', () => init(root));
  }
})(typeof window !== 'undefined' ? window : globalThis);
