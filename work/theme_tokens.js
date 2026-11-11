'use strict';
/* Reads theme.css the way the browser does for tests: the derived block (:root, [data-theme]) plus one theme's block, every
   var() and color-mix(in srgb, ...) worked out to an sRGB colour. Not a test file (node --test work/test_*.js skips it).

     themeIds()            the data-theme ids that have a block, default first
     tokens(id)            {name: raw value} as the browser sees them for <html data-theme=id>
     colour(expr, id)      [r, g, b, a] (0-255, alpha 0-1) of a value such as 'var(--text)' or '#fff'
     hex(expr, id)         '#rrggbb' or '#rrggbbaa'
     contrast(fg, bg, id)  WCAG ratio; a translucent colour is laid over the one under it (bg over --bg first)
     core()                the token names every theme must set (the default block's own names)
     isColour(name)        false for the few tokens that are not colours (status symbols, the scrollbar pair) */
const fs = require('node:fs');
const path = require('node:path');
const { APP } = require('./_paths');
const { cssRules } = require('./css_rules.js');

const THEME_CSS = path.join(APP, 'theme.css');
let cache = null;
function load() {
  if (cache) return cache;
  const rules = cssRules(fs.readFileSync(THEME_CSS, 'utf8'));
  const derived = {},
    blocks = {},
    order = [];
  for (const r of rules) {
    const own = Object.fromEntries(
      Object.entries(r.declarations).filter(([k]) => k.startsWith('--') || k === 'color-scheme'),
    );
    if (r.context) throw new Error(`theme.css: no at-rules expected (${r.context})`);
    if (r.selector === ':root' || r.selector === '[data-theme]') Object.assign(derived, own);
    else {
      const m = /^\[data-theme='([a-z0-9-]+)'\]$/.exec(r.selector);
      if (m) {
        if (!blocks[m[1]]) order.push(m[1]);
        blocks[m[1]] = Object.assign(blocks[m[1]] || {}, own);
      } else if (r.selector !== ':root:not([data-theme])')
        throw new Error('theme.css: unexpected selector ' + r.selector);
    }
  }
  cache = { derived, blocks, order };
  return cache;
}

const themeIds = () => load().order.slice();
function tokens(id) {
  const { derived, blocks } = load();
  if (!blocks[id]) throw new Error('no theme ' + id);
  return { ...derived, ...blocks[id] };
}
function core() {
  const { derived, blocks, order } = load();
  return Object.keys(blocks[order[0]]).filter((k) => isColour(k) && !(k in derived));
}
/** Tokens that are not colours: the status symbols (strings) and the scrollbar pair. */
const isColour = (name) => name.startsWith('--') && !name.endsWith('-glyph') && name !== '--scrollbar-colors';

function splitTop(s) {
  const out = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}
function parseHex(h) {
  let d = h.slice(1).toLowerCase();
  if (d.length === 3 || d.length === 4) d = [...d].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(d)) throw new Error('bad colour ' + h);
  const n = (i) => parseInt(d.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), d.length === 8 ? n(6) / 255 : 1];
}
/** CSS color-mix(in srgb, a p%, b): premultiplied alpha, as browsers do. */
function mix(a, p, b) {
  const w1 = p / 100,
    w2 = 1 - w1,
    alpha = a[3] * w1 + b[3] * w2;
  if (alpha === 0) return [0, 0, 0, 0];
  return [0, 1, 2].map((i) => (a[i] * a[3] * w1 + b[i] * b[3] * w2) / alpha).concat(alpha);
}
function evaluate(expr, env, depth = 0, seen = []) {
  expr = String(expr).trim();
  if (depth > 40) throw new Error('var() loop: ' + seen.join(' -> '));
  if (expr.startsWith('#')) return parseHex(expr);
  if (expr === 'transparent') return [0, 0, 0, 0];
  if (expr === 'white') return [255, 255, 255, 1];
  if (expr === 'black') return [0, 0, 0, 1];
  let m = /^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/s.exec(expr);
  if (m) {
    if (Object.hasOwn(env, m[1])) return evaluate(env[m[1]], env, depth + 1, seen.concat(m[1]));
    if (m[2] !== undefined) return evaluate(m[2], env, depth + 1, seen);
    throw new Error(`${m[1]} is not defined` + (seen.length ? ` (via ${seen.join(' -> ')})` : ''));
  }
  m = /^color-mix\((.*)\)$/s.exec(expr);
  if (m) {
    const [space, a, b] = splitTop(m[1]);
    if (space !== 'in srgb') throw new Error('only color-mix(in srgb, ...) is used: ' + expr);
    const pct = (part) => {
      const mm = /^(.*?)\s+(\d+(?:\.\d+)?)%$/s.exec(part);
      return mm ? [mm[1], Number(mm[2])] : [part, null];
    };
    const [ea, pa] = pct(a),
      [eb, pb] = pct(b);
    const p = pa !== null ? pa : pb !== null ? 100 - pb : 50;
    return mix(evaluate(ea, env, depth + 1, seen), p, evaluate(eb, env, depth + 1, seen));
  }
  throw new Error('not a colour: ' + expr);
}
const colour = (expr, id) => evaluate(expr, tokens(id));
const toHex = (c) =>
  '#' +
  c
    .slice(0, 3)
    .map((x) => Math.round(x).toString(16).padStart(2, '0'))
    .join('') +
  (c[3] < 0.999
    ? Math.round(c[3] * 255)
        .toString(16)
        .padStart(2, '0')
    : '');
const hex = (expr, id) => toHex(colour(expr, id));
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
function luminance(c) {
  const [r, g, b] = c.slice(0, 3).map((x) => {
    x /= 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Contrast of fg on bg in theme id; bg is laid over `under` (default var(--bg)) and fg over bg when translucent. */
function contrast(fg, bg, id, under = 'var(--bg)') {
  const base = over(colour(under, id), [0, 0, 0, 1]);
  const b = over(colour(bg, id), base);
  const f = over(colour(fg, id), b);
  const [x, y] = [luminance(f), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

module.exports = { themeIds, tokens, core, isColour, colour, hex, contrast, evaluate, luminance, THEME_CSS };
