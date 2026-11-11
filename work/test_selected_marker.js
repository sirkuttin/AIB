'use strict';
/* The selected chat card's marker is its own straight pill, not an inset box-shadow: an inset shadow follows the card's rounded
   corners and bends like a bracket. The card's size, padding, radius and the marker colour are unchanged. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { cssRules, declarationsFor } = require('./css_rules');
const T = require('./theme_tokens.js'); // colours are theme tokens

const rules = cssRules(fs.readFileSync(path.join(APP, 'workspace.css'), 'utf8'));
const decl = (sel) => declarationsFor(rules, sel);

test('the selected card has no inset bar shadow; the marker is a straight ::before pill in the same colour', () => {
  assert.equal(decl('aside .connection.selected')['box-shadow'], undefined);
  const pill = decl('aside .connection.selected::before');
  assert.equal(pill.content, "''");
  assert.equal(pill.position, 'absolute');
  assert.equal(pill.width, '3px');
  assert.equal(pill.background, 'var(--sel-bar)');
  assert.equal(T.hex(pill.background, 'teal-dark'), T.hex('var(--accent)', 'teal-dark'));
  assert.ok(pill.top && pill.bottom && pill.left, 'placed inside the card, clear of the rounded corners');
  assert.equal(decl('aside .connection').position, 'relative');
});

test('the card keeps its size, padding and radius: only position: relative is new', () => {
  const card = decl('aside .connection');
  // No 72 px cap any more: a fourth line (the branch) adds height instead of being centred over the clip (test_card_layout.js).
  assert.equal(card['max-height'], undefined);
  assert.equal(card['align-content'], 'flex-start');
  for (const [k, v] of Object.entries({
    height: 'auto',
    'min-height': '56px',
    margin: '0',
    padding: '6px 8px',
    'border-radius': '6px',
    border: '0',
    overflow: 'hidden',
  }))
    assert.equal(card[k], v, k);
  assert.deepEqual(decl('aside .connection.selected'), { background: 'var(--sel)' });
});

test('needs-you / unread outlines on the selected card are the 1px outline only', () => {
  // QA c1: needs-you is a thin amber outline, so it no longer looks like the purple focus ring or the selected card.
  // The outline is the theme's needs-you line (Dracula-style keeps the old amber).
  const needs = 'inset 0 0 0 1px var(--card-needs-line)';
  assert.equal(decl('aside .connection.selected.attn-needs_you')['box-shadow'], needs);
  assert.equal(decl('aside .connection.attn-needs_you:not(.selected)')['box-shadow'], needs);
  assert.equal(decl('aside .connection.selected.attn-unread')['box-shadow'], 'inset 0 0 0 1px var(--status-done-line)');
  for (const r of rules) {
    if (/\.connection/.test(r.selector) && r.declarations['box-shadow']) {
      assert.ok(!/inset 3px/.test(r.declarations['box-shadow']), r.selector);
    }
  }
});
