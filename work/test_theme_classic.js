'use strict';
/* Classic purple is AIB as it looked before the teal styling: every colour declaration that existed at BASE (the last commit
   before the styling and the themes) must paint the same colour today with data-theme='classic'. Shapes the styling changed
   for every theme (a filled chip, a solid disabled button) are not colours and are not compared. The few colours Classic
   purple changed on purpose are listed in CHANGED, each with its reason; anything else that differs fails.
   Skipped when the checkout's history does not contain BASE. */
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { APP } = require('./_paths');
const { cssRules } = require('./css_rules.js');
const T = require('./theme_tokens.js');

const BASE = '1543633';
const REPO = path.join(__dirname, '..');
const SHEETS = ['chat', 'activity', 'workspace', 'clamp', 'stream', 'header', 'inbox-reply', 'commands', 'queue', 'textsize',
  'settings', 'changes', 'artifacts', 'plan', 'split', 'views', 'start-page', 'terminal'];
// selector + property -> why Classic purple paints a different colour there now
const CHANGED = {
  // contrast fixes (work/test_themes.js): the smallest lightness change that reaches 4.5:1 / 3:1
  '--text-faint': 'placeholders and composer notes: #747d90 -> #7f899c for 4.5:1 on raised panels',
  '--text-faint-2': 'message times: #737e94 -> #7e899f for 4.5:1 on raised panels',
  '--text-faint-3': 'artifact shortcuts: #6d7184 -> #84889b for 4.5:1',
  '--status-done-line': 'unread card outline: #3d5f86 -> #46678e for 3:1',
  '--cg-no-text': 'Changes pane line numbers: #5f6475 -> #7a7f91 for 4.5:1',
  '--cg-del-no-text': 'Changes pane removed-line numbers: #b87480 -> #c47f8b for 4.5:1',
};

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}
function available() {
  try {
    git(['cat-file', '-e', BASE + '^{commit}']);
    return true;
  } catch {
    return false;
  }
}

/* Every colour expression in a CSS value -> '#rrggbb[aa]', using `colourOf` for var()/color-mix()/hex/rgb(). */
const START = /var\(|color-mix\(|rgba?\(|#[0-9a-fA-F]{3,8}\b/g;
function normalise(value, colourOf) {
  let out = '',
    i = 0;
  START.lastIndex = 0;
  let m;
  while ((m = START.exec(value))) {
    let end = m.index + m[0].length;
    if (m[0].endsWith('(')) {
      let depth = 1;
      while (end < value.length && depth) {
        if (value[end] === '(') depth++;
        else if (value[end] === ')') depth--;
        end++;
      }
    }
    const expr = value.slice(m.index, end);
    let c = expr;
    try {
      c = colourOf(expr);
    } catch (e) {
      if (!/is not defined|not a colour/.test(e.message)) throw e; // a size or font variable, not a colour
    }
    out += value.slice(i, m.index) + c;
    i = end;
    START.lastIndex = end;
  }
  return (out + value.slice(i)).replace(/\s+/g, ' ').trim();
}
const toHex = (c) =>
  '#' + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('') +
  (c[3] < 0.999 ? Math.round(c[3] * 255).toString(16).padStart(2, '0') : '');
function rgbFn(expr) {
  const m = /^rgba?\(([^)]*)\)$/.exec(expr);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
function keyed(sheets) {
  const out = new Map();
  for (const [name, css] of Object.entries(sheets)) {
    const count = new Map();
    for (const r of cssRules(css)) {
      if (r.selector === ':root') continue;
      for (const [prop, value] of Object.entries(r.declarations)) {
        if (prop.startsWith('--')) continue;
        const k = `${name}.css|${r.context}|${r.selector}|${prop}`;
        const n = (count.get(k) || 0) + 1;
        count.set(k, n);
        out.set(`${k}|${n}`, value);
      }
    }
  }
  return out;
}

test('Classic purple paints every colour AIB painted before the teal styling', { skip: available() ? false : `history has no ${BASE}` }, () => {
  const baseSheets = Object.fromEntries(SHEETS.map((n) => [n, git(['show', `${BASE}:outputs/agent-studio/${n}.css`])]));
  // the old colours: theme.css's :root tokens plus each sheet's own :root names
  const env = {};
  for (const css of [git(['show', `${BASE}:outputs/agent-studio/theme.css`]), ...Object.values(baseSheets)])
    for (const r of cssRules(css)) if (r.selector === ':root' && !r.context) for (const [k, v] of Object.entries(r.declarations)) if (k.startsWith('--')) env[k] = v;
  const oldColour = (expr) => toHex(rgbFn(expr) || T.evaluate(expr, env));
  const classic = T.tokens('classic');
  const newColour = (expr) => toHex(rgbFn(expr) || T.evaluate(expr, classic));
  const now = keyed(Object.fromEntries(SHEETS.map((n) => [n, fs.readFileSync(path.join(APP, n + '.css'), 'utf8')])));
  const before = keyed(baseSheets);
  // tokens Classic changed on purpose: their old value, so a site that only differs through them is expected
  const fixed = Object.keys(CHANGED).filter((k) => k.startsWith('--'));
  const problems = [];
  let compared = 0;
  for (const [k, oldValue] of before) {
    if (!now.has(k)) continue; // a rule the styling removed or rewrote: its shape changed for every theme
    const nowValue = now.get(k);
    START.lastIndex = 0;
    if (!START.test(oldValue) && !START.test(nowValue)) continue;
    let a, b;
    try {
      a = normalise(oldValue, oldColour);
      b = normalise(nowValue, newColour);
    } catch (e) {
      problems.push(`${k}: ${e.message}`);
      continue;
    }
    compared++;
    if (a === b) continue;
    if (fixed.some((t) => nowValue.includes(`var(${t})`) || nowValue.includes(`var(${t},`))) continue;
    if (k.includes('.status-dot.d-else|border') && a.replace('solid', 'dashed') === b) continue; // Elsewhere dots are dashed now
    problems.push(`${k}: was ${a}, is ${b} (${nowValue})`);
  }
  assert.ok(compared > 300, `compared ${compared} colour declarations`);
  assert.deepEqual(problems, [], problems.slice(0, 30).join('\n'));
});
