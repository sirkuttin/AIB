'use strict';
/* Text size: two independent sizes, a code font and a line spacing, remembered per window-width bucket.
     chat text  80-160 %  messages, tables/lists, tool rows, code and command output, subagent history, message box, queued messages
     interface  90-150 %  everything else (chat list, tabs, header, Activity, menus, dialogs)
   At 100 % / default font / Comfortable nothing is added to the page at all (no custom properties, no attributes), so it renders
   exactly as before. Scaling uses CSS `zoom` on containers (textsize.css), switched on by attributes on <html>.
   The pure helpers at the top have node tests; the DOM part starts at init(). */
(function (root) {
  const CHAT = { min: 80, max: 160, step: 10, def: 100 },
    UI = { min: 90, max: 150, step: 10, def: 100 };
  /* The fixed list offered for code. Only the ones this browser can really draw are shown. */
  const FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Fira Code', 'Courier New'];
  const SPACINGS = ['compact', 'comfortable', 'roomy'];
  const SPACING_LABEL = { compact: 'Compact', comfortable: 'Comfortable', roomy: 'Roomy' };
  const num = (v) => typeof v === 'number' && isFinite(v);
  /* Snap to the step and keep inside the range. Anything that is not a number means "100 %". */
  function clampPct(v, r) {
    v = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!num(v)) return r.def;
    return Math.min(Math.max(Math.round(v / r.step) * r.step, r.min), r.max);
  }
  function stepPct(cur, dir, r) {
    const c = clampPct(cur, r);
    return clampPct(c + (dir < 0 ? -r.step : r.step), r);
  }
  const range = (which) => (which === 'ui' ? UI : CHAT);
  /* Local-storage bucket: the same laptop / big-monitor split resize-ui.js uses for panel widths (its helper is reused when present). */
  function bucketKey(width, helper) {
    if (helper && typeof helper.bucketKey === 'function') return helper.bucketKey(width);
    const w = Number(width);
    return w < 1400 ? '<1400' : w < 1800 ? '<1800' : '>=1800';
  }
  const storageKey = (width, helper) => 'studio-textsize-v1:' + bucketKey(width, helper);
  /* The last values set in any bucket: a bucket with nothing stored of its own starts from these, so maximizing the window (another
     bucket) does not look like the setting was lost. Once a bucket has its own values they stay its own. */
  const LAST_KEY = 'studio-textsize-v1:last';
  const pickStored = (own, last) => (own != null && own !== '' ? own : last);
  const DEFAULTS = Object.freeze({ chat: 100, ui: 100, font: '', spacing: 'comfortable' });
  /* Stored values: out-of-range numbers are clamped, unknown fonts/spacings mean "default". Never throws. */
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
    return {
      chat: clampPct(o.chat, CHAT),
      ui: clampPct(o.ui, UI),
      font: FONTS.includes(o.font) ? o.font : '',
      spacing: SPACINGS.includes(o.spacing) ? o.spacing : 'comfortable',
    };
  }
  /* Which keys change which size. Ctrl+= / Ctrl+- / Ctrl+0 are the chat text, and only while focus or the pointer is in the chat area
   (elsewhere the browser keeps its own zoom). Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0 are the interface, anywhere.
   Returns {target:'chat'|'ui', dir:+1|-1|0 (0 = reset)} or null when the key is not ours. */
  function keyAction(e, inChat) {
    if (!e || !e.ctrlKey || e.altKey || e.metaKey) return null;
    const k = String(e.key == null ? '' : e.key),
      c = String(e.code == null ? '' : e.code);
    const plus = k === '=' || k === '+' || c === 'Equal' || c === 'NumpadAdd';
    const minus = k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract';
    const zero = k === '0' || c === 'Digit0' || c === 'Numpad0';
    const dir = plus ? 1 : minus ? -1 : zero ? 0 : null;
    if (dir === null) return null;
    if (e.shiftKey) return { target: 'ui', dir };
    return inChat ? { target: 'chat', dir } : null;
  }
  /* Page zoom in the desktop app. A browser keeps its own zoom (Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+wheel, touchpad pinch) wherever the app
   does not use those keys; the AIB window (WebView2) would zoom the whole page with them, which the old Tauri app had turned off.
   In the app every Ctrl+plus/minus and every Ctrl+wheel the text-size handling does not use is swallowed instead. Ctrl+0 outside the
   chat is left alone: it can only bring the page back to 100 %, the way out if a zoom still happens (inside an artifact frame the
   page cannot see the events, so a Ctrl+wheel there is not caught). */
  function isPageZoomKey(e) {
    if (!e || !e.ctrlKey || e.altKey || e.metaKey) return false;
    const k = String(e.key == null ? '' : e.key),
      c = String(e.code == null ? '' : e.code);
    return (
      k === '=' || k === '+' || k === '-' || k === '_' || ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'].includes(c)
    );
  }
  const isPageZoomWheel = (e) => !!(e && e.ctrlKey && !e.altKey && !e.metaKey);
  /* Ctrl+wheel over the chat: one step per notch. A touchpad sends many small deltas, so they add up to WHEEL_STEP first. */
  const WHEEL_STEP = 60;
  function wheelAction(e, inChat, acc) {
    acc = num(acc) ? acc : 0;
    if (!e || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !inChat) return { handled: false, steps: 0, acc: 0 };
    const d = Number(e.deltaY) || 0;
    if (d === 0) return { handled: true, steps: 0, acc };
    if (acc !== 0 && Math.sign(acc) !== Math.sign(d)) acc = 0;
    acc += d;
    const n = Math.trunc(Math.abs(acc) / WHEEL_STEP);
    const steps = n ? n * (acc < 0 ? 1 : -1) : 0; // wheel up (negative delta) = bigger
    return { handled: true, steps, acc: n ? acc - Math.sign(acc) * n * WHEEL_STEP : acc };
  }
  /* Font detection by width: draw a test string in `name` with each of three generic fallbacks; if any width differs from the
   plain fallback, the font really exists. `measure(fontCss)` returns a width (a canvas in the page, a fake in the tests). */
  const BASES = ['monospace', 'sans-serif', 'serif'];
  function fontAvailable(name, measure) {
    try {
      for (const base of BASES) {
        const plain = measure('72px ' + base),
          withIt = measure('72px "' + name + '", ' + base);
        if (num(plain) && num(withIt) && Math.abs(plain - withIt) > 0.01) return true;
      }
    } catch (e) {}
    return false;
  }
  function availableFonts(measure, list) {
    return (list || FONTS).filter((n) => fontAvailable(n, measure));
  }
  /* A remembered font that this PC cannot draw (any more) falls back to the default stack. */
  const resolveFont = (choice, available) =>
    FONTS.includes(choice) && (available || []).includes(choice) ? choice : '';
  const pure = {
    CHAT,
    UI,
    FONTS,
    SPACINGS,
    SPACING_LABEL,
    DEFAULTS,
    WHEEL_STEP,
    clampPct,
    stepPct,
    bucketKey,
    storageKey,
    LAST_KEY,
    pickStored,
    sanitize,
    keyAction,
    wheelAction,
    isPageZoomKey,
    isPageZoomWheel,
    fontAvailable,
    availableFonts,
    resolveFont,
  };

  /* ---- the page part --------------------------------------------------------------------------------------------- */
  let api = pure,
    live = null;
  const CHAT_AREA = '#chat, #submessages, #commandDetails';
  function init(win, opts) {
    win = win || root;
    const doc = win.document,
      body = doc.body,
      rootEl = doc.documentElement;
    opts = opts || {};
    if (!body || rootEl.dataset.textSizeInit) return null;
    rootEl.dataset.textSizeInit = '1';
    const helper = opts.bucketHelper || win.ResizeUI;
    /* In the desktop app (asked on every event: the window bindings may arrive after the page script ran). */
    const inApp =
      typeof opts.desktop === 'function'
        ? opts.desktop
        : () => {
            try {
              return !!(win.AibDesktop && win.AibDesktop.available());
            } catch (e) {
              return false;
            }
          };
    const store = () => {
      try {
        return win.localStorage;
      } catch (e) {
        return null;
      }
    };
    const read = (k) => {
      try {
        const s = store();
        return s ? s.getItem(k) : null;
      } catch (e) {
        return null;
      }
    };
    const write = (k, v) => {
      try {
        const s = store();
        if (s) s.setItem(k, v);
      } catch (e) {}
    };
    const keyNow = () => storageKey(win.innerWidth, helper);
    let bucket = bucketKey(win.innerWidth, helper);
    const readBucket = () => pickStored(read(keyNow()), read(LAST_KEY));
    let state = { ...sanitize(readBucket()) };
    let available = null;
    const subs = new Set();
    let lastTarget = null,
      wheelAcc = 0,
      badge = null,
      badgeTimer = 0;

    const measure = (font) => {
      const c = doc.createElement('canvas'),
        g = c.getContext && c.getContext('2d');
      if (!g) return NaN;
      g.font = font;
      return g.measureText('mmmmmmmmmmlliWW@#0O').width;
    };
    function fonts() {
      if (!available) available = opts.fonts || availableFonts(measure);
      return available;
    }

    /* (a list scroll-controller.js manages keeps its own place: its rows' resize is put back before paint) */
    function messagesBoxes() {
      return [doc.getElementById('messages'), doc.getElementById('submessages')].filter((b) => b && !b._scrollCtl);
    }
    /* Keep the message being read where it is while sizes change: remember the first message that is visible and how far below the
    top it sits, change the size, then scroll so it is back at the same spot. At the bottom, stay at the bottom. */
    function anchorsBefore() {
      return messagesBoxes().map((box) => {
        const bt = box.getBoundingClientRect().top,
          atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 2;
        let el = null,
          off = 0;
        for (const ch of box.children) {
          const r = ch.getBoundingClientRect();
          if (r.height > 0 && r.bottom > bt + 1) {
            el = ch;
            off = r.top - bt;
            break;
          }
        }
        return { box, el, off, atEnd };
      });
    }
    function anchorsAfter(list) {
      for (const a of list) {
        const { box } = a;
        if (a.atEnd) {
          box.scrollTop = box.scrollHeight; // old main-list scroll code (aib-scroll-v2 = '0'): managed lists are skipped
          continue;
        }
        if (!a.el || !a.el.isConnected) continue;
        const z = parseFloat(win.getComputedStyle(box).zoom) || 1;
        const bt = box.getBoundingClientRect().top,
          delta = a.el.getBoundingClientRect().top - bt - a.off;
        if (Math.abs(delta) > 0.5) box.scrollTop += delta / z; // old main-list scroll code (aib-scroll-v2 = '0')
      }
    }

    /* Writes the state onto <html>. At the defaults every property and attribute is removed again. */
    function render() {
      const st = rootEl.style,
        set = (k, v) => {
          if (v == null) {
            st.removeProperty(k);
          } else st.setProperty(k, v);
        };
      const attr = (n, v) => {
        if (v == null) rootEl.removeAttribute(n);
        else rootEl.setAttribute(n, v);
      };
      const chat = state.chat !== CHAT.def,
        ui = state.ui !== UI.def;
      set('--chat-scale', chat ? String(state.chat / 100) : null);
      attr('data-chat-scaled', chat ? '' : null);
      set('--ui-scale', ui ? String(state.ui / 100) : null);
      attr('data-ui-scaled', ui ? '' : null);
      const font = resolveFont(state.font, fonts());
      set('--code-font', font ? '"' + font + '"' : null);
      attr('data-code-font', font ? '' : null);
      attr('data-line-spacing', state.spacing !== 'comfortable' ? state.spacing : null);
    }
    function showBadge(text) {
      if (!body) return;
      if (!badge) {
        badge = doc.createElement('div');
        badge.id = 'textSizeBadge';
        badge.className = 'textsize-badge';
        badge.setAttribute('role', 'status');
        badge.setAttribute('aria-live', 'polite');
        body.appendChild(badge);
      }
      badge.textContent = text;
      badge.classList.add('on');
      win.clearTimeout(badgeTimer);
      badgeTimer = win.setTimeout(() => {
        if (badge) badge.classList.remove('on');
      }, 1400);
    }
    function persist() {
      const json = JSON.stringify(state);
      write(keyNow(), json);
      write(LAST_KEY, json);
    }
    function emit(which) {
      const snap = { ...state };
      for (const fn of [...subs]) {
        try {
          fn(snap, which);
        } catch (e) {}
      }
    }
    function commit(next, which, badgeText) {
      const prev = state;
      state = sanitize(next);
      if (
        state.chat === prev.chat &&
        state.ui === prev.ui &&
        state.font === prev.font &&
        state.spacing === prev.spacing
      ) {
        if (badgeText) showBadge(badgeText());
        return false;
      }
      const anchors = anchorsBefore();
      render();
      persist();
      anchorsAfter(anchors);
      if (badgeText) showBadge(badgeText());
      emit(which);
      return true;
    }
    const chatText = () => 'Chat text ' + state.chat + '%',
      uiText = () => 'Interface ' + state.ui + '%';
    const setChat = (v, quiet) => commit({ ...state, chat: clampPct(v, CHAT) }, 'chat', quiet ? null : chatText);
    const setUi = (v, quiet) => commit({ ...state, ui: clampPct(v, UI) }, 'ui', quiet ? null : uiText);
    const setFont = (v) => commit({ ...state, font: FONTS.includes(v) ? v : '' }, 'font');
    const setSpacing = (v) => commit({ ...state, spacing: SPACINGS.includes(v) ? v : 'comfortable' }, 'spacing');
    function step(which, dir) {
      const r = range(which),
        cur = which === 'ui' ? state.ui : state.chat;
      const v = dir === 0 ? r.def : stepPct(cur, dir, r);
      return which === 'ui' ? setUi(v) : setChat(v);
    }
    const inChat = (el) => !!(el && el.closest && el.closest(CHAT_AREA));
    /* "Where the user is": the focused element, or when nothing is focused the last thing the pointer was over. */
    function inChatNow() {
      const ae = doc.activeElement;
      if (ae && ae !== body && ae !== rootEl) return inChat(ae);
      return inChat(lastTarget);
    }
    function onKeydown(e) {
      if (e.defaultPrevented) return;
      const act = keyAction(e, inChatNow());
      if (!act) {
        if (isPageZoomKey(e) && inApp()) e.preventDefault(); // no page zoom in the app window
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      step(act.target, act.dir);
    }
    function onWheel(e) {
      const r = wheelAction(e, inChat(e.target), wheelAcc);
      if (!r.handled) {
        wheelAcc = 0;
        if (isPageZoomWheel(e) && inApp()) e.preventDefault(); // no page zoom in the app window
        return;
      }
      e.preventDefault();
      wheelAcc = r.acc;
      if (r.steps) step('chat', r.steps > 0 ? 1 : -1);
    }
    function onResize() {
      const b = bucketKey(win.innerWidth, helper);
      if (b === bucket) return;
      bucket = b;
      const next = sanitize(readBucket());
      const prev = state;
      if (next.chat === prev.chat && next.ui === prev.ui && next.font === prev.font && next.spacing === prev.spacing)
        return;
      const anchors = anchorsBefore();
      state = next;
      render();
      anchorsAfter(anchors);
      emit('bucket');
    }
    /* Popups are placed with viewport coordinates, but a zoomed popup multiplies left/top too: move it back inside the window. */
    function fitPopup(node) {
      if (!node || !node.style || !node.getBoundingClientRect) return;
      const z = parseFloat(win.getComputedStyle(node).zoom) || 1;
      if (z === 1) return;
      const r = node.getBoundingClientRect(),
        vw = win.innerWidth || 1200,
        vh = win.innerHeight || 800;
      let left = parseFloat(node.style.left),
        top = parseFloat(node.style.top);
      if (!isFinite(left) || !isFinite(top)) return;
      left = Math.max(8, Math.min(vw - r.width - 8, left));
      top = Math.max(8, Math.min(vh - r.height - 8, top));
      node.style.left = left / z + 'px';
      node.style.top = top / z + 'px';
    }
    function onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => subs.delete(fn);
    }
    const ctl = {
      getChat: () => state.chat,
      setChat: (v) => setChat(v),
      getUi: () => state.ui,
      setUi: (v) => setUi(v),
      getCodeFont: () => resolveFont(state.font, fonts()),
      setCodeFont: setFont,
      getLineSpacing: () => state.spacing,
      setLineSpacing: setSpacing,
      /* [{name, label}] the font picker offers: Default first, then only the fonts this browser can draw. */
      fontOptions: () => [{ name: '', label: 'Default' }].concat(fonts().map((n) => ({ name: n, label: n }))),
      spacingOptions: () => SPACINGS.map((n) => ({ name: n, label: SPACING_LABEL[n] })),
      bigger: (which) => step(which === 'ui' ? 'ui' : 'chat', 1),
      smaller: (which) => step(which === 'ui' ? 'ui' : 'chat', -1),
      reset: (which) => step(which === 'ui' ? 'ui' : 'chat', 0),
      onChange,
      fitPopup,
      get: () => ({ ...state }),
      limits: () => ({ chat: { ...CHAT }, ui: { ...UI } }),
    };
    live = { ctl, onKeydown, onWheel, onResize };
    doc.addEventListener(
      'mouseover',
      (e) => {
        lastTarget = e.target;
      },
      true,
    );
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('wheel', onWheel, { capture: true, passive: false });
    win.addEventListener('resize', onResize);
    render();
    if (state.chat !== CHAT.def || state.ui !== UI.def) win.setTimeout(() => emit('init'), 0);
    return ctl;
  }
  api = Object.assign({}, pure, { init });
  root.TextSizeUI = api;
  /* The Settings page (Appearance) and the Ctrl+K actions call these by name. Until init() has run they do nothing. */
  const fwd =
    (name, fallback) =>
    (...a) =>
      live ? live.ctl[name](...a) : fallback;
  root.AgentTextSize = {
    getChat: fwd('getChat', CHAT.def),
    setChat: fwd('setChat', false),
    getUi: fwd('getUi', UI.def),
    setUi: fwd('setUi', false),
    getCodeFont: fwd('getCodeFont', ''),
    setCodeFont: fwd('setCodeFont', false),
    getLineSpacing: fwd('getLineSpacing', 'comfortable'),
    setLineSpacing: fwd('setLineSpacing', false),
    fontOptions: fwd('fontOptions', [{ name: '', label: 'Default' }]),
    spacingOptions: fwd(
      'spacingOptions',
      SPACINGS.map((n) => ({ name: n, label: SPACING_LABEL[n] })),
    ),
    bigger: fwd('bigger', false),
    smaller: fwd('smaller', false),
    reset: fwd('reset', false),
    onChange: (fn) =>
      live
        ? live.ctl.onChange(fn)
        : (pending.push(fn),
          () => {
            const i = pending.indexOf(fn);
            if (i >= 0) pending.splice(i, 1);
          }),
    fitPopup: fwd('fitPopup', undefined),
    get: fwd('get', { ...DEFAULTS }),
    limits: () => ({ chat: { ...CHAT }, ui: { ...UI } }),
  };
  /* onChange listeners registered before init() are attached once it has run. */
  const pending = [];
  function flushPending() {
    if (live) for (const fn of pending.splice(0)) live.ctl.onChange(fn);
  }
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && root === (typeof window !== 'undefined' ? window : null)) {
    const start = () => {
      init(root);
      flushPending();
    };
    /* Wait for DOMContentLoaded (every deferred script, resize-ui.js included, has run by then) so its bucket helper is there to reuse. */
    if (document.readyState === 'complete') start();
    else document.addEventListener('DOMContentLoaded', start);
  }
})(typeof window !== 'undefined' ? window : globalThis);
