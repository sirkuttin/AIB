'use strict';
/* The text/background pairs AIB actually paints, for the contrast check in test_themes.js. Two sources:
   1. PAIRS below: the pairs that matter most, named by role (body, meta, muted, chips, buttons, links, code, diff, status,
      the selected card, needs-you), each with the surfaces it is drawn on.
   2. ruleRules(): every rule in the page stylesheets that sets both a text colour and a background, read from the CSS, so a
      new chip or badge is checked without anyone adding it here.
   Targets (WCAG 2.2): 4.5:1 for body and meta text, 3:1 for large text and for borders, rings and dots that carry meaning.
   Not a test file. */
const fs = require('node:fs');
const path = require('node:path');
const { APP } = require('./_paths');
const { cssRules } = require('./css_rules.js');

const TEXT = 4.5,
  UI = 3;
const SURFACES = ['--bg', '--panel', '--panel-2'];
const P = [];
const add = (group, fg, bgs, min, note) => {
  for (const bg of [].concat(bgs)) P.push({ group, fg, bg, min, note });
};
// body and meta text
add('body', '--text', [...SURFACES, '--bg-field', '--code-bg', '--hover', '--bg-composer', '--bg-row'], TEXT);
add('meta', '--muted', [...SURFACES, '--bg-field', '--bg-composer', '--bg-row', '--hover'], TEXT, 'meta lines, agent names');
add('meta', '--text-muted', [...SURFACES, '--bg-row'], TEXT, 'qualifiers, timestamps');
add('meta', '--text-faint-2', [...SURFACES], TEXT, 'message times (12 px)');
add('meta', '--text-dim', [...SURFACES], TEXT, 'activity and sub-agent text');
add('muted', '--text-faint', [...SURFACES, '--bg-field', '--bg-composer'], TEXT, 'placeholders, composer notes');
add('muted', '--text-faint-3', [...SURFACES], TEXT, 'artifact shortcuts and counts');
add('muted', '--text-muted-2', [...SURFACES], TEXT, 'plan qualifiers');
for (const t of ['--text-2', '--text-3', '--text-4', '--text-5', '--text-6', '--text-7']) add('body', t, SURFACES, TEXT);
// links
add('link', '--link', [...SURFACES, '--bg-composer', '--accent-wash', '--accent-wash-2', '--accent-wash-3', '--accent-wash-4', '--accent-wash-5'], TEXT);
// buttons
add('button', '--on-accent', '--accent', TEXT, 'primary button');
add('button', '--on-accent-disabled', '--primary-disabled-bg', UI, 'disabled primary (Send with nothing to send)');
add('button', '--accent', [...SURFACES, '--bg-field', '--bg-composer'], UI, 'focus ring, accent border');
add('button', '--text-bright', '--bg-composer', UI, 'ring round a focused primary button');
add('button', '--text', '--button-bg', TEXT, 'plain button');
// the selected card and the active chat
add('selected', '--text', ['--sel', '--accent-wash'], TEXT, 'selected card title');
add('selected', '--muted', ['--sel', '--accent-wash'], TEXT, 'selected card meta');
add('selected', '--row-agent-text', ['--sel', '--panel'], TEXT, 'agent name on a card');
add('selected', '--sel-bar', ['--sel', '--panel'], UI, 'selected-card bar');
add('selected', '--accent-line', ['--panel', '--bg'], UI, 'selected borders');
// status words, chips, dots
for (const s of ['working', 'needs', 'done', 'idle']) {
  add('status', `--status-${s}`, [`--status-${s}-bg`], TEXT, `${s} chip`);
  add('status', `--status-${s}`, ['--bg', '--panel', '--bg-row', '--accent-wash'], s === 'idle' ? TEXT : TEXT, `${s} word`);
}
for (const s of ['needs', 'done']) add('status', `--status-${s}-line`, ['--bg', '--panel', '--bg-row'], UI, `${s} card outline`); // the Working turn-line border sits round its own words: decorative
add('needs-you', '--status-needs-bg', '--status-needs', TEXT, 'count badge');
add('needs-you', '--status-needs-line', ['--panel', '--sel'], UI, 'needs-you card outline');
add('needs-you', '--text', '--panel-2', TEXT, 'approval / question card');
add('needs-you', '--status-needs', '--panel-2', TEXT, 'approval / question card title dot and words');
add('status', '--hd-work', ['--status-working-bg'], TEXT, 'header Working chip');
add('status', '--hd-need', ['--status-needs-bg'], TEXT, 'header Needs-you chip');
add('status', '--hd-turn', ['--status-done-bg'], TEXT, 'header Your-turn chip');
add('status', '--hd-idle', ['--status-idle-bg'], TEXT, 'header Idle chip');
// danger, ok, warn text
add('status', '--danger-bright', [...SURFACES, '--tool-failed-bg'], TEXT, 'error text, failed tool');
add('status', '--danger-text', SURFACES, TEXT, 'ownership and error notes');
add('status', '--warn-text', SURFACES, TEXT, 'hold note');
add('status', '--ok-text', SURFACES, TEXT, 'idle words, notify on');
add('status', '--danger', SURFACES, UI, 'failure dot');
// code and diffs
for (const t of ['--syn-keyword', '--syn-string', '--syn-number', '--syn-comment', '--syn-key', '--text'])
  add('code', t, ['--code-bg', '--code-bg-inline'], TEXT);
add('diff', '--ok-text-2', ['--code-bg', '--diff-add-bg'], TEXT, 'added line (+)');
add('diff', '--diff-removed-text', ['--code-bg', '--diff-del-bg'], TEXT, 'removed line (-)');
add('diff', '--ok-bright', ['--syn-add-bg'], TEXT, 'added token');
add('diff', '--syn-del-text', ['--syn-del-bg'], TEXT, 'removed token');
add('diff', '--cg-text', ['--cg-add-bg', '--cg-del-bg', '--code-bg'], TEXT, 'Changes pane line text');
add('diff', '--cg-add-no-text', ['--cg-add-no-bg'], TEXT, 'Changes pane + line number');
add('diff', '--cg-del-no-text', ['--cg-del-no-bg'], TEXT, 'Changes pane - line number');
add('diff', '--git-modified-text', SURFACES, TEXT, 'M');
add('diff', '--git-renamed-text', SURFACES, TEXT, 'R');
add('diff', '--git-conflict-text', [...SURFACES, '--git-conflict-bg'], TEXT, 'C / conflict');
// terminal
for (const t of ['--term-fg', '--term-red', '--term-green', '--term-yellow', '--term-blue', '--term-magenta', '--term-cyan', '--term-dim'])
  add('terminal', t, ['--term-bg'], TEXT);
add('terminal', '--term-fg', ['--term-sel'], TEXT, 'selected text');

const PAGE_SKIP = new Set(['theme.css', 'style.css', 'sidebar.css']); // the old monitor pages have their own colours
function pageSheets() {
  return fs
    .readdirSync(APP)
    .filter((n) => n.endsWith('.css') && !PAGE_SKIP.has(n))
    .sort();
}
const ONE = /^var\(--[\w-]+\)$/;
/** Rules that set both color and background to one token each: [{group:'rule', fg, bg, min, note}]. */
function ruleRules() {
  const out = [],
    seen = new Set();
  for (const name of pageSheets()) {
    for (const r of cssRules(fs.readFileSync(path.join(APP, name), 'utf8'))) {
      const d = r.declarations;
      const fg = d.color,
        bg = d.background || d['background-color'];
      if (!fg || !bg || !ONE.test(fg) || !ONE.test(bg)) continue;
      if (/:disabled|\[disabled\]|\[aria-disabled/.test(r.selector)) continue; // disabled controls are exempt (WCAG 1.4.3)
      const f = fg.slice(4, -1),
        b = bg.slice(4, -1),
        key = f + '|' + b;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ group: 'rule', fg: f, bg: b, min: TEXT, note: `${name} ${r.selector}` });
    }
  }
  return out;
}
const allPairs = () => P.concat(ruleRules());
module.exports = { PAIRS: P, ruleRules, allPairs, pageSheets, TEXT, UI };
