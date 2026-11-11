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
// The approved styling is the AIB teal (dark) theme: read its tokens the way the browser does (theme_tokens.js).
const T = require('./theme_tokens.js');
const THEME = 'teal-dark';
const raw = T.tokens(THEME);
const tokens = new Proxy(
  {},
  { get: (_, n) => (typeof n === 'string' && n in raw ? T.hex(`var(${n})`, THEME) : undefined) },
);
const header = sheet('header.css');
const colour = (value) => T.hex(value, THEME);
const contrast = (a, b) => T.contrast(a, b, THEME);
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
  for (const s of [
    '--bg',
    '--panel',
    '--bg-composer',
    '--accent-wash',
    '--accent-wash-2',
    '--accent-wash-3',
    '--accent-wash-4',
    '--accent-wash-5',
  ])
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
    assert.equal(colour(chip.background), tokens[`--status-${name}-bg`], `header chip ${t} fill`);
    assert.equal(colour(chip.color), tokens[`--status-${name}`], `header chip ${t} text`);
    const mirror = declarationsFor(sheet('split.css'), `.mirror-status[data-tone='${t}']`);
    assert.equal(colour(mirror.background), tokens[`--status-${name}-bg`], `split pane chip ${t} fill`);
  }
  // Elsewhere · Working keeps the Working colour, with a dashed ring; Elsewhere · Idle is grey.
  assert.equal(colour(declarationsFor(header, "#status[data-tone='else-work']").color), tokens['--status-working']);
  assert.equal(declarationsFor(header, "#status[data-tone='else-work']::before").border, '1.5px dashed var(--hd-work)');
  assert.equal(colour(declarationsFor(header, "#status[data-tone='else']").color), tokens['--status-idle']);
  assert.equal(
    declarationsFor(sheet('workspace.css'), '.status-dot.d-else-work').border,
    '2px dashed var(--hd-work, var(--status-working))',
  );
  const settings = sheet('settings.css');
  assert.equal(colour(declarationsFor(settings, '.st-status.ok').background), tokens['--status-done-bg']);
  assert.equal(colour(declarationsFor(settings, '.st-status.warn').background), tokens['--status-needs-bg']);
  assert.equal(colour(declarationsFor(settings, '.st-status.dim').background), tokens['--status-idle-bg']);
  const chat = sheet('chat.css');
  assert.equal(declarationsFor(chat, '.tool-status.status-in_progress').background, 'var(--status-working-bg)');
  assert.equal(declarationsFor(chat, '.tool-status.status-completed').background, 'var(--status-done-bg)');
  assert.equal(colour(declarationsFor(chat, '.st-needs_you').background), tokens['--status-needs']);
  const activity = sheet('activity.css');
  assert.equal(declarationsFor(activity, '.sa-working .sa-dot').background, 'var(--status-working)');
  assert.equal(declarationsFor(activity, '.sa-completed .sa-dot').background, 'var(--status-done)');
});

test('disabled and focused primary buttons, spinners and cards follow the design review', () => {
  const chat = sheet('chat.css');
  const disabled = declarationsFor(chat, '.primary:disabled');
  assert.equal(disabled.opacity, '1', 'no half-transparent teal');
  assert.equal(colour(disabled.background), tokens['--accent-wash-2']);
  assert.equal(disabled.color, 'var(--on-accent-disabled)');
  const focus = declarationsFor(chat, '.primary:focus-visible');
  assert.equal(focus.outline, '2px solid var(--text-bright)');
  assert.equal(focus['outline-offset'], '2px');
  atLeast('var(--text-bright)', 'var(--bg-composer)', 3);
  // the spinner track is a translucent amber, not the near-invisible chip fill
  assert.match(tokens['--status-working-track'], /^#ffc247[0-9a-f]{2}$/i);
  assert.equal(
    declarationsFor(sheet('workspace.css'), '.status-dot.d-work').border,
    '2px solid var(--status-working-track)',
  );
  assert.equal(declarationsFor(chat, '.st-working').border, '2px solid var(--status-working-track)');
  // approval and question cards: a plain panel with a coral border, not a coral block
  assert.equal(colour(declarationsFor(chat, '.approval').background), tokens['--panel-2']);
  assert.equal(colour(declarationsFor(chat, '.elicitation-card').background), tokens['--panel-2']);
  assert.equal(declarationsFor(chat, '.approval h3::before').background, 'var(--status-needs)');
  for (const fg of ['--text', '--muted', '--status-needs']) atLeast(`var(${fg})`, 'var(--panel-2)', 4.5);
  // the question card's Submit keeps the disabled wash, not the first-child teal fill
  const qDisabled = declarationsFor(chat, '.elicitation-actions button.primary:disabled');
  assert.equal(colour(qDisabled.background), tokens['--accent-wash-2']);
  assert.equal(qDisabled.color, 'var(--on-accent-disabled)');
});

test('sidebar chat cards: one 14 px mark column, one step larger type; size and padding as before (test_card_layout.js)', () => {
  const ws = sheet('workspace.css');
  const card = declarationsFor(ws, 'aside .connection');
  // Padding, height and the count badge's place come from the card-size fix (base), not from the styling round.
  assert.equal(card.padding, '6px 8px');
  assert.equal(card['min-height'], '56px');
  assert.equal(card['align-content'], 'flex-start');
  const mark = declarationsFor(ws, 'aside .connection .status-mark');
  assert.equal(mark.flex, '0 0 14px');
  assert.equal(mark.width, '14px');
  assert.equal(declarationsFor(ws, 'aside .connection .status-mark .status-count').position, 'absolute');
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
