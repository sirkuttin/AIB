'use strict';
/* The selected chat card's marker is its own straight pill, not an inset box-shadow: an inset shadow follows the card's rounded
   corners and bends like a bracket. The card's size, padding, radius and the marker colour are unchanged. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { cssRules, declarationsFor } = require('./css_rules');

const rules = cssRules(fs.readFileSync(path.join(APP, 'workspace.css'), 'utf8'));
const decl = (sel) => declarationsFor(rules, sel);

test('the selected card has no inset bar shadow; the marker is a straight ::before pill in the same colour', () => {
  assert.equal(decl('aside .connection.selected')['box-shadow'], undefined);
  const pill = decl('aside .connection.selected::before');
  assert.equal(pill.content, "''");
  assert.equal(pill.position, 'absolute');
  assert.equal(pill.width, '3px');
  assert.equal(pill.background, '#a98be2');
  assert.ok(pill.top && pill.bottom && pill.left, 'placed inside the card, clear of the rounded corners');
  assert.equal(decl('aside .connection').position, 'relative');
});

test('the card keeps its size, padding and radius: only position: relative is new', () => {
  const card = decl('aside .connection');
  for (const [k, v] of Object.entries({
    height: 'auto',
    'min-height': '56px',
    'max-height': '72px',
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
  assert.equal(decl('aside .connection.selected.attn-needs_you')['box-shadow'], 'inset 0 0 0 1px var(--accent-line)');
  assert.equal(decl('aside .connection.selected.attn-unread')['box-shadow'], 'inset 0 0 0 1px #3d5f86');
  for (const r of rules) {
    if (/\.connection/.test(r.selector) && r.declarations['box-shadow']) {
      assert.ok(!/inset 3px/.test(r.declarations['box-shadow']), r.selector);
    }
  }
});
