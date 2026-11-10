'use strict';
const { APP: APP_DIR } = require('./_paths');
/* Your own messages keep the purple box but have no visible title bar: the "You" label stays for screen readers,
   and the time and Copy button float at the top right and show on hover or focus (always on touch). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cssRules, declarationsFor } = require('./css_rules.js');

const css = fs.readFileSync(path.join(APP_DIR, 'chat.css'), 'utf8');
const rules = cssRules(css);
const decl = (selector, context) => declarationsFor(rules, selector, context);
const HEAD = '.bubble.user > .bubble-head';

test('the purple box is unchanged', () => {
  assert.deepEqual(decl('.bubble.user'), { background: '#272031', 'border-color': '#4d3c65' });
  const box = decl('.bubble');
  assert.equal(box['border-radius'], '9px');
  assert.equal(box.border, '1px solid var(--line)');
});

test('the user header has no divider and takes no row of its own', () => {
  const head = decl(HEAD);
  assert.equal(head.border, '0');
  assert.equal(head.background, 'transparent');
  assert.equal(head.float, 'right');
  assert.notEqual(head.display, 'none');
});

test('the label is visually hidden but kept for screen readers', () => {
  const label = decl(HEAD + ' > strong');
  assert.equal(label['clip-path'], 'inset(50%)');
  assert.equal(label.width, '1px');
  assert.equal(label.position, 'absolute');
  assert.notEqual(label.display, 'none');
  assert.notEqual(label.visibility, 'hidden');
});

test('time and Copy are hidden until hover or focus, small and muted; always shown on touch', () => {
  assert.equal(decl(HEAD + ' > time').color, '#737e94');
  assert.equal(decl(HEAD + ' > time')['font-size'], '10px');
  for (const part of ['time', '.copy-ctl']) {
    assert.equal(decl(`${HEAD} > ${part}`).opacity, '0');
    assert.equal(decl(`.bubble.user:hover > .bubble-head > ${part}`).opacity, '1');
    assert.equal(decl(`.bubble.user:focus-within > .bubble-head > ${part}`).opacity, '1');
    assert.equal(decl(`${HEAD} > ${part}`, '@media (hover: none)').opacity, '1');
  }
});

test('the user rules do not leak to other bubbles', () => {
  const leaks = rules.filter((r) => /\.bubble\.user/.test(r.selector) && /assistant|tool|notice/.test(r.selector));
  assert.equal(leaks.length, 0);
  assert.equal(decl('.bubble-head')['border-bottom'], '1px solid #292b35');
});
