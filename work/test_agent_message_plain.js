'use strict';
const { APP: APP_DIR } = require('./_paths');
/* Agent messages are plain text on the page (no box, no visible title bar); the time always shows. User bubbles keep their box. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cssRules, declarationsFor } = require('./css_rules.js');

const rules = cssRules(fs.readFileSync(path.join(APP_DIR, 'chat.css'), 'utf8'));
const decl = (selector, context) => declarationsFor(rules, selector, context);
/* Colours are named in theme.css (var(--token)); these checks care about the colour, so resolve the names. */
const tokens = declarationsFor(cssRules(fs.readFileSync(path.join(APP_DIR, 'theme.css'), 'utf8')), ':root');
const hex = (value) => String(value).replace(/var\((--[\w-]+)\)/g, (all, name) => tokens[name] ?? all);

test('assistant bubbles have no border, background or card shape', () => {
  const d = decl('.bubble.assistant');
  assert.equal(d.border, '0');
  assert.equal(d.background, 'transparent');
  assert.equal(d['border-radius'], '0');
});

test('assistant header is kept for screen readers but not drawn', () => {
  const head = decl('.bubble.assistant > .bubble-head');
  assert.equal(head.position, 'absolute');
  assert.equal(head.border, '0');
  assert.equal(head.background, 'transparent');
  const label = decl('.bubble.assistant > .bubble-head > strong');
  assert.equal(label['clip-path'], 'inset(50%)');
  assert.equal(label.width, '1px');
  assert.notEqual(label.display, 'none');
});

test('assistant time always shows, muted 12px at the top right', () => {
  const time = { ...decl('.bubble-head time'), ...decl('.bubble.assistant > .bubble-head > time') };
  assert.equal(time.opacity, undefined);
  assert.equal(hex(time.color), '#929aaa');
  assert.equal(time['font-size'], '12px');
  assert.equal(decl('.bubble.assistant > .bubble-head').right, '0');
  assert.deepEqual(decl('.bubble.assistant:hover > .bubble-head > time'), {});
  assert.deepEqual(decl('.bubble.assistant:focus-within > .bubble-head > time'), {});
});

test('assistant text keeps the user bubble text metrics', () => {
  assert.equal(decl('.bubble > .markdown')['font-size'], '13px');
  assert.equal(decl('.bubble pre')['line-height'], '1.8');
  assert.equal(decl('.bubble > .markdown').padding, '12px 15px');
  assert.equal(decl('.bubble.assistant > pre')['padding-left'], '15px');
});

test('user bubbles are unchanged', () => {
  const box = decl('.bubble');
  assert.equal(box.border, '1px solid var(--line)');
  assert.equal(box['border-radius'], '9px');
  assert.equal(hex(box.background), '#181a21');
  assert.deepEqual(decl('.bubble.user'), { background: '#272031', 'border-color': '#4d3c65' }); // not tokenised
  assert.equal(hex(decl('.bubble-head')['border-bottom']), '1px solid #292b35'); // other bubbles keep their title bar
  assert.equal(rules.filter((r) => /\.bubble\.user/.test(r.selector) && /assistant/.test(r.selector)).length, 0);
});
