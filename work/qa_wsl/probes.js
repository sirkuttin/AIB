'use strict';
/* Functions that run in the page (passed to browser.evaluate): computed styles of equivalent elements, effective colours and
   WCAG contrast, the focus walk, the visible strings. Each is self-contained (no closures over Node values). */

// Computed styles + box of the first match of each selector inside scope (document when no scope matches).
function measure(map, scopeSel) {
  const scope = (scopeSel && document.querySelector(scopeSel)) || document;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 1;
  const cv = cvs.getContext('2d', { willReadFrequently: true });
  const norm = (c) => {
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return 'transparent';
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = '#000';
    cv.fillStyle = c;
    cv.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
    const h = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return a === 255 ? h : a === 0 ? 'transparent' : h + ' @' + Math.round((a / 255) * 100) + '%';
  };
  const PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderTopLeftRadius', 'gap', 'textTransform', 'letterSpacing', 'textDecorationLine', 'opacity', 'textAlign', 'display', 'alignItems', 'whiteSpace', 'fontStyle'];
  const out = {};
  for (const [label, sel] of Object.entries(map)) {
    const all = [...scope.querySelectorAll(sel)].filter((e) => e.getClientRects().length);
    if (!all.length) {
      out[label] = null;
      continue;
    }
    const one = (e) => {
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    const s = { count: all.length, x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    for (const p of PROPS) {
      let v = cs[p];
      if (/color/i.test(p)) v = norm(v);
      s[p] = v;
    }
    s.text = (e.innerText || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return s;
    };
    const s = one(all[0]);
    s.items = all.slice(1, 8).map(one);
    out[label] = s;
  }
  return out;
}

// Effective foreground / background of each element (ancestors' backgrounds composited, opacity applied) and the WCAG ratio.
function contrast(items) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const px = () => Array.from(g.getImageData(0, 0, 1, 1).data);
  const lum = ([r, gg, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b);
  };
  const hex = (a) => '#' + a.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
  const out = [];
  for (const it of items) {
    const all = [...document.querySelectorAll(it.sel)].filter((e) => it.hidden || e.getClientRects().length);
    const e = all[0];
    if (!e) continue;
    const chain = [];
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 1, 1);
    let alpha = 1;
    for (const n of chain) {
      const cs = getComputedStyle(n);
      alpha *= parseFloat(cs.opacity) || (cs.opacity === '0' ? 0 : 1);
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        g.globalAlpha = n === e ? alpha : 1;
        g.fillStyle = bg;
        g.fillRect(0, 0, 1, 1);
      }
    }
    const bgPx = px();
    const fg = it.fg ? it.fg(e) : getComputedStyle(e).color;
    g.globalAlpha = alpha;
    g.fillStyle = fg;
    g.fillRect(0, 0, 1, 1);
    const fgPx = px();
    g.globalAlpha = 1;
    const l1 = lum(fgPx),
      l2 = lum(bgPx);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const cs = getComputedStyle(e);
    const size = parseFloat(cs.fontSize),
      bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const target = it.ui ? 3 : large ? 3 : 4.5;
    out.push({ label: it.label, sel: it.sel, text: (e.innerText || e.textContent || '').trim().slice(0, 50), fg: hex(fgPx), bg: hex(bgPx), ratio: Math.round(ratio * 100) / 100, target, pass: ratio >= target, fontSize: size, opacity: alpha });
  }
  return out;
}

// What the focused element is, and whether a focus mark is drawn.
function focusInfo() {
  const e = document.activeElement;
  if (!e || e === document.body) return { tag: 'BODY' };
  const cs = getComputedStyle(e);
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
  return {
    tag: e.tagName,
    cls: String(e.className || '').slice(0, 40),
    text: (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    type: e.type || '',
    role: e.getAttribute('role') || '',
    ariaLabel: e.getAttribute('aria-label') || '',
    checked: 'checked' in e ? e.checked : null,
    focusVisible: e.matches(':focus-visible'),
    outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
    boxShadow: cs.boxShadow,
    ring,
    inDialog: !!e.closest('.wl-remove, .dp-dialog, dialog'),
    inContent: !!e.closest('.st-content'),
  };
}

// Every visible text run (and title / aria-label) under the given roots, de-duplicated.
function strings(roots) {
  const seen = new Set();
  const out = [];
  const push = (kind, s) => {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2 || seen.has(kind + s)) return;
    seen.add(kind + s);
    out.push({ kind, s });
  };
  for (const sel of roots) {
    for (const root of document.querySelectorAll(sel)) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const p = n.parentElement;
        if (!p || !p.getClientRects().length || p.closest('script,style,.qa-term')) continue;
        push('text', p.closest('p,li,dd,dt,button,label,h2,h3,h4,option,span,strong,code,a,div') === p ? p.innerText : n.textContent);
      }
      for (const e of root.querySelectorAll('[title],[aria-label],option')) {
        if (e.title) push('title', e.title);
        if (e.getAttribute('aria-label')) push('aria', e.getAttribute('aria-label'));
        if (e.tagName === 'OPTION') push('option', e.textContent);
      }
    }
  }
  return out;
}

// Overflow / clipping inside a root: elements whose content is wider than their box, or that stick out of the viewport.
function overflow(rootSel) {
  const root = document.querySelector(rootSel) || document.body;
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const e of root.querySelectorAll('*')) {
    if (!e.getClientRects().length) continue;
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    const name = e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '');
    const text = (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (r.right > vw + 0.5 && cs.position !== 'fixed') out.push({ kind: 'past the window edge', el: name, text, by: Math.round(r.right - vw) });
    if (e.scrollWidth > e.clientWidth + 1 && cs.overflowX !== 'visible' && !/auto|scroll/.test(cs.overflowX) && e.clientWidth > 0)
      out.push({ kind: cs.textOverflow === 'ellipsis' ? 'cut with …' : 'clipped', el: name, text, by: e.scrollWidth - e.clientWidth });
    if (e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(cs.overflowX) && e.clientWidth > 0 && !/st-content|dp-dialog/.test(name))
      out.push({ kind: 'scrolls sideways', el: name, text, by: e.scrollWidth - e.clientWidth });
  }
  // de-duplicate nested repeats
  const seen = new Set();
  return out.filter((o) => {
    const k = o.kind + o.el + o.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { measure, contrast, focusInfo, strings, overflow };
