'use strict';
/* Bay teal styling: the one accent and the four agent-status chips (Working amber, Needs you coral, Done teal, Idle grey).
   The colours live in theme.css; this test resolves them and computes WCAG contrast, so a later value change that makes a
   pair unreadable fails here: 4.5:1 for text, 3:1 for focus rings and borders. It also checks that the status chips and
   dots actually paint with these tokens. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { cssRules, declarationsFor } = require('./css_rules.js');

const sheet = (name) => cssRules(fs.readFileSync(path.join(APP, name), 'utf8'));
const tokens = declarationsFor(sheet('theme.css'), ':root');
const header = sheet('header.css');
const hd = declarationsFor(header, ':root'); // --hd-work ... point at the status tokens

/** The literal colour of a value: follows var(--x) through theme.css and header.css's own names. */
function colour(value) {
  let v = String(value).trim();
  for (let n = 0; n < 10; n++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (!m) break;
    v = tokens[m[1]] ?? hd[m[1]];
    assert.ok(v, `${m[1]} is defined`);
  }
  assert.match(v, /^#[0-9a-f]{6}$/i, `${value} resolves to an opaque colour`);
  return v;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [luminance(colour(a)), luminance(colour(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const atLeast = (fg, bg, min) => {
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= min, `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
};

const CHIPS = {
  working: ['#ffc247', '#3a2e14'],
  needs: ['#ff9a80', '#3d1f18'],
  done: ['#5ed6c5', '#12302c'],
  idle: ['#c9c5bb', '#26272f'],
};

test('the four status chips have the board colours and meet 4.5:1', () => {
  for (const [name, [fg, bg]] of Object.entries(CHIPS)) {
    assert.equal(tokens[`--status-${name}`].toLowerCase(), fg, `--status-${name}`);
    assert.equal(tokens[`--status-${name}-bg`].toLowerCase(), bg, `--status-${name}-bg`);
    atLeast(`var(--status-${name})`, `var(--status-${name}-bg)`, 4.5);
  }
});

test('status text, dots and borders stay readable on the page surfaces', () => {
  const surfaces = ['--bg', '--panel', '--bg-row', '--accent-wash']; // page, sidebar, turn line, the selected chat row
  for (const s of surfaces) for (const name of Object.keys(CHIPS)) atLeast(`var(--status-${name})`, `var(${s})`, 4.5);
  for (const line of ['--status-working-line', '--status-needs-line', '--status-done-line', '--accent-line'])
    for (const s of ['--bg', '--panel', '--bg-row']) atLeast(`var(${line})`, `var(${s})`, 3);
  atLeast('var(--status-needs-bg)', 'var(--status-needs)', 4.5); // count badges: dark text on a coral fill
});

test('Bay teal accent: buttons, links, focus and the active chat', () => {
  assert.equal(tokens['--accent'].toLowerCase(), '#2bb3a3');
  atLeast('var(--on-accent)', 'var(--accent)', 4.5); // primary buttons
  for (const s of ['--bg', '--panel', '--bg-composer', '--accent-wash', '--accent-wash-2', '--accent-wash-3', '--accent-wash-4', '--accent-wash-5'])
    atLeast('var(--link)', `var(${s})`, 4.5);
  for (const s of ['--bg', '--panel', '--bg-field', '--accent-wash']) atLeast('var(--accent)', `var(${s})`, 3); // focus rings
  for (const t of ['--text', '--muted', '--text-muted']) atLeast(`var(${t})`, 'var(--accent-wash)', 4.5); // active chat row text
});

test('status chips and dots paint with the status tokens', () => {
  const tone = { work: 'working', turn: 'done', need: 'needs', idle: 'idle' };
  for (const [t, name] of Object.entries(tone)) {
    const chip = declarationsFor(header, `#status[data-tone='${t}']`);
    assert.equal(chip.background, `var(--status-${name}-bg)`, `header chip ${t} fill`);
    assert.equal(colour(chip.color), tokens[`--status-${name}`], `header chip ${t} text`);
    const mirror = declarationsFor(sheet('split.css'), `.mirror-status[data-tone='${t}']`);
    assert.equal(mirror.background, `var(--status-${name}-bg)`, `split pane chip ${t} fill`);
  }
  const settings = sheet('settings.css');
  assert.equal(declarationsFor(settings, '.st-status.ok').background, 'var(--status-done-bg)');
  assert.equal(declarationsFor(settings, '.st-status.warn').background, 'var(--status-needs-bg)');
  assert.equal(declarationsFor(settings, '.st-status.dim').background, 'var(--status-idle-bg)');
  const chat = sheet('chat.css');
  assert.equal(declarationsFor(chat, '.tool-status.status-in_progress').background, 'var(--status-working-bg)');
  assert.equal(declarationsFor(chat, '.tool-status.status-completed').background, 'var(--status-done-bg)');
  assert.equal(declarationsFor(chat, '.st-needs_you').background, 'var(--status-needs)');
  const activity = sheet('activity.css');
  assert.equal(declarationsFor(activity, '.sa-working .sa-dot').background, 'var(--status-working)');
  assert.equal(declarationsFor(activity, '.sa-completed .sa-dot').background, 'var(--status-done)');
});
