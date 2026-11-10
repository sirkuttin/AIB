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
  if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map((c) => c + c).join('');
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

// Text and dots: the icon's saturated agent colours (amber, coral, teal); fills: the board's dark chip fills.
const CHIPS = {
  working: ['#ffc247', '#3a2e14'],
  needs: ['#ff7a59', '#3d1f18'],
  done: ['#2bb3a3', '#12302c'],
  idle: ['#c9c5bb', '#26272f'],
};

test('the four status chips use the icon colours on the board fills and meet 4.5:1', () => {
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
  for (const t of ['--text', '--muted', '--text-dim']) atLeast(`var(${t})`, 'var(--accent-wash)', 4.5); // active chat row text
  assert.equal(tokens['--accent-wash'].toLowerCase(), '#17332f'); // the board's active chat
  atLeast('var(--on-accent-disabled)', 'var(--accent-wash-2)', 4.5); // disabled Send / Queue
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
  // Elsewhere · Working keeps the Working colour, with a dashed ring; Elsewhere · Idle is grey.
  assert.equal(colour(declarationsFor(header, "#status[data-tone='else-work']").color), tokens['--status-working']);
  assert.equal(declarationsFor(header, "#status[data-tone='else-work']::before").border, '1.5px dashed var(--hd-work)');
  assert.equal(colour(declarationsFor(header, "#status[data-tone='else']").color), tokens['--status-idle']);
  assert.equal(declarationsFor(sheet('workspace.css'), '.status-dot.d-else-work').border, '2px dashed var(--hd-work, var(--status-working))');
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

test('disabled and focused primary buttons, spinners and cards follow the design review', () => {
  const chat = sheet('chat.css');
  const disabled = declarationsFor(chat, '.primary:disabled');
  assert.equal(disabled.opacity, '1', 'no half-transparent teal');
  assert.equal(disabled.background, 'var(--accent-wash-2)');
  assert.equal(disabled.color, 'var(--on-accent-disabled)');
  const focus = declarationsFor(chat, '.primary:focus-visible');
  assert.equal(focus.outline, '2px solid var(--text-bright)');
  assert.equal(focus['outline-offset'], '2px');
  atLeast('var(--text-bright)', 'var(--bg-composer)', 3);
  // the spinner track is a translucent amber, not the near-invisible chip fill
  assert.match(tokens['--status-working-track'], /^#ffc247[0-9a-f]{2}$/i);
  assert.equal(declarationsFor(sheet('workspace.css'), '.status-dot.d-work').border, '2px solid var(--status-working-track)');
  assert.equal(declarationsFor(chat, '.st-working').border, '2px solid var(--status-working-track)');
  // approval and question cards: a plain panel with a coral border, not a coral block
  assert.equal(declarationsFor(chat, '.approval').background, 'var(--panel-2)');
  assert.equal(declarationsFor(chat, '.elicitation-card').background, 'var(--panel-2)');
  assert.equal(declarationsFor(chat, '.approval h3::before').background, 'var(--status-needs)');
  for (const fg of ['--text', '--muted', '--status-needs']) atLeast(`var(${fg})`, 'var(--panel-2)', 4.5);
  // the question card's Submit keeps the disabled wash, not the first-child teal fill
  const qDisabled = declarationsFor(chat, '.elicitation-actions button.primary:disabled');
  assert.equal(qDisabled.background, 'var(--accent-wash-2)');
  assert.equal(qDisabled.color, 'var(--on-accent-disabled)');
});

test('sidebar chat cards: one 14 px mark column, compact spacing, one step larger type', () => {
  const ws = sheet('workspace.css');
  const card = declarationsFor(ws, 'aside .connection');
  assert.equal(card.padding, '6px 10px');
  assert.equal(card.gap, '2px 8px');
  assert.equal(card['align-content'], 'flex-start');
  assert.equal(card['min-height'], '0');
  assert.equal(card['max-height'], 'none');
  assert.equal(declarationsFor(ws, 'aside .conversation-row').margin, '0 0 4px');
  const mark = declarationsFor(ws, 'aside .connection .status-mark');
  assert.equal(mark.flex, '0 0 14px');
  assert.equal(mark.width, '14px');
  // a count badge replaces the dot (the dot stays for screen readers, out of sight)
  assert.equal(declarationsFor(ws, 'aside .connection .status-mark:has(.status-count) .status-dot').position, 'absolute');
  assert.equal(declarationsFor(ws, 'aside .connection .status-count')['min-width'], '14px');
  const title = declarationsFor(ws, 'aside .connection .connection-title');
  assert.deepEqual([title['font-size'], title['line-height'], title['font-weight']], ['14px', '18px', '600']);
  for (const sel of ['aside .connection .row-status', 'aside .connection .row-line3']) {
    assert.equal(declarationsFor(ws, sel)['padding-left'], '22px', sel); // 14 px mark + 8 px gap
    assert.equal(declarationsFor(ws, sel)['font-size'], '12px', sel);
  }
  assert.equal(declarationsFor(ws, 'aside .connection .row-agent')['font-size'], '12px');
  const chip = declarationsFor(header, 'header #status');
  assert.deepEqual([chip.height, chip['font-weight']], ['24px', '600']);
  assert.equal(declarationsFor(sheet('settings.css'), '.st-status')['font-weight'], '600');
});
