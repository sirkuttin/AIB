'use strict';
/* Colour themes: theme.css holds every colour as a token, each theme is one token block, and every theme is readable.
   - every theme in themes.js has a block in theme.css and the other way round, with color-scheme set;
   - every theme defines every core token, and every token works out to a colour in every theme;
   - the page stylesheets name no colour of their own (only var(--token)), and every var() they use is defined;
   - WCAG contrast of every text/background pair the page paints (theme_pairs.js) meets its target in every theme:
     4.5:1 for text, 3:1 for borders, rings and dots that carry meaning. A theme whose THEMES entry says
     contrast: 'high' must reach 7:1 and 4.5:1 instead.
   A new theme is checked by this test as soon as its block and its THEMES entry exist. */
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { APP } = require('./_paths');
const T = require('./theme_tokens.js');
const { allPairs, pageSheets, TEXT } = require('./theme_pairs.js');
const Themes = require(path.join(APP, 'themes.js'));

const ids = T.themeIds();
const entry = (id) => Themes.THEMES.find((t) => t.id === id);

test('every theme in the picker has a token block in theme.css, and every block is in the picker', () => {
  assert.deepEqual([...ids].sort(), Themes.THEMES.map((t) => t.id).sort());
  assert.equal(ids[0], Themes.DEFAULT, 'the default block comes first');
  for (const id of ids) {
    const scheme = T.tokens(id)['color-scheme'];
    assert.ok(scheme === 'dark' || scheme === 'light', `${id} sets color-scheme`);
    assert.equal(scheme, entry(id).scheme, `${id}: color-scheme matches its THEMES entry`);
    assert.ok(Themes.GROUPS.includes(entry(id).group), `${id} is in a picker group`);
  }
  assert.ok(Themes.valid(Themes.SYSTEM.dark) && Themes.valid(Themes.SYSTEM.light));
});

test('the default theme is AIB teal (dark), and it also paints a page with no data-theme', () => {
  assert.equal(Themes.DEFAULT, 'teal-dark');
  const css = fs.readFileSync(T.THEME_CSS, 'utf8');
  assert.match(css, /:root:not\(\[data-theme\]\),\s*\[data-theme='teal-dark'\]\s*\{/);
  assert.equal(Themes.resolve(undefined, false), 'teal-dark');
  assert.equal(Themes.resolve('nope', true), 'teal-dark');
  assert.equal(Themes.resolve('system', true), 'teal-light');
  assert.equal(Themes.resolve('system', false), 'teal-dark');
});

test('every theme sets every core token, and every token resolves to a colour', () => {
  const core = T.core();
  assert.ok(core.length >= 30, 'core tokens: ' + core.length);
  const names = Object.keys(T.tokens(ids[0])).filter((k) => T.isColour(k));
  for (const id of ids) {
    const own = T.tokens(id);
    for (const n of core) assert.ok(Object.hasOwn(own, n), `${id} sets ${n}`);
    for (const n of names) assert.doesNotThrow(() => T.colour(`var(${n})`, id), `${id}: ${n}`);
  }
});

const COMMENT = /\/\*[\s\S]*?\*\//g;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:white|black)(?![\w-])/g;
test('page stylesheets name no colour of their own, and every var() they use is defined', () => {
  const defined = new Set(Object.keys(T.tokens(ids[0])));
  const problems = [];
  for (const name of pageSheets()) {
    if (name === 'theme.css') continue;
    const text = fs.readFileSync(path.join(APP, name), 'utf8').replace(COMMENT, '');
    for (const line of text.split('\n')) {
      if (/mask-image/.test(line)) continue; // an alpha mask: its colour is never seen
      const lits = line.match(LITERAL);
      if (lits) problems.push(`${name}: ${line.trim()}`);
    }
    const own = new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      const n = m[1];
      if (defined.has(n) || own.has(n)) continue;
      if (m[2] === ',') continue; // has a fallback (sizes and fonts set from script: --ui-scale, --side-w ...)
      if (/^--(ui-scale|chat-scale|side-w|act-split|composer-h|depth|hd-h|tabs-h|sans|code-font|activity-w)$/.test(n))
        continue;
      problems.push(`${name}: var(${n}) is not defined`);
    }
  }
  assert.deepEqual(problems, [], problems.slice(0, 30).join('\n'));
});

test('the terminal and the swatches read their colours from the theme', () => {
  const js = fs.readFileSync(path.join(APP, 'terminal-ui.js'), 'utf8');
  for (const n of [
    '--term-bg',
    '--term-fg',
    '--term-sel',
    '--term-red',
    '--term-green',
    '--term-yellow',
    '--term-blue',
    '--term-magenta',
    '--term-cyan',
    '--term-dim',
  ]) {
    assert.ok(js.includes(`'${n}'`), `terminal-ui.js reads ${n}`);
    for (const id of ids) assert.doesNotThrow(() => T.colour(`var(${n})`, id));
  }
  assert.match(js, /attributeFilter: \[[^\]]*'data-theme'/, 'the terminal re-reads its colours when the theme changes');
  const html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  assert.ok(
    html.indexOf('<script src="/themes.js"></script>') < html.indexOf('theme.css'),
    'themes.js runs before the styles, not deferred',
  );
});

for (const id of ids) {
  test(`contrast: ${id}`, () => {
    const high = entry(id).contrast === 'high';
    const fails = [];
    for (const p of allPairs()) {
      const min = high ? (p.min >= TEXT ? 7 : 4.5) : p.min;
      const r = T.contrast(`var(${p.fg})`, `var(${p.bg})`, id);
      if (r < min - 0.005)
        fails.push(
          `${r.toFixed(2)}:1 < ${min}  ${p.fg} ${T.hex(`var(${p.fg})`, id)} on ${p.bg} ${T.hex(`var(${p.bg})`, id)}  (${p.group}${p.note ? ': ' + p.note : ''})`,
        );
    }
    assert.deepEqual(fails, [], fails.join('\n'));
  });
}

test('themes.js: choosing paints <html> at once and saves the choice', () => {
  const attrs = {},
    store = {};
  const root = {
    document: { documentElement: { getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => (attrs[k] = v) } },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)) },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
  };
  const src = fs.readFileSync(path.join(APP, 'themes.js'), 'utf8');
  const fn = new Function('window', 'globalThis', 'module', 'document', src);
  const mod = { exports: {} };
  fn(undefined, root, mod, undefined);
  const A = root.AibThemes;
  assert.equal(A.saved(), 'teal-dark');
  assert.equal(A.choose('nord'), 'nord');
  assert.deepEqual([attrs['data-theme'], store['aib-theme']], ['nord', 'nord']);
  // Classic purple was replaced by Dracula-style: an old saved id paints Dracula
  store['aib-theme'] = 'classic';
  delete attrs['data-theme-pref']; // as on a fresh page load without the server's attribute
  assert.equal(A.saved(), 'dracula');
  assert.equal(A.resolve('purple', false), 'dracula');
  assert.equal(A.choose('classic'), 'dracula');
  assert.equal(store['aib-theme'], 'dracula');
  // status symbols: off by default, saved, on <html>
  assert.equal(A.symbolsOn(), false);
  A.setSymbols(true);
  assert.deepEqual([store['aib-status-glyphs'], attrs['data-status-glyphs']], ['on', 'on']);
  assert.equal(A.themeShowsSymbols('cb-safe'), true);
  assert.equal(A.themeShowsSymbols('teal-dark'), false);
  assert.equal(A.choose('system'), 'teal-light'); // the stub prefers light
  assert.equal(attrs['data-theme-pref'], 'system');
  assert.equal(A.choose('bogus'), null);
  attrs['data-theme-pref'] = 'teal-light'; // what the server writes wins over localStorage
  assert.equal(A.saved(), 'teal-light');
});
