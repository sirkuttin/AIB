'use strict';
const { APP: APP_DIR } = require('./_paths');
/* Your own messages keep the purple box but have no visible title bar: the "You" label stays for screen readers,
   and the time and Copy button float at the top right and always show, at a readable size. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cssRules, declarationsFor } = require('./css_rules.js');

const css = fs.readFileSync(path.join(APP_DIR, 'chat.css'), 'utf8');
const rules = cssRules(css);
const decl = (selector, context) => declarationsFor(rules, selector, context);
const HEAD = '.bubble.user > .bubble-head';
/* Colours are named in theme.css (var(--token)); resolve them to check contrast. */
const tokens = declarationsFor(cssRules(fs.readFileSync(path.join(APP_DIR, 'theme.css'), 'utf8')), ':root');
const hex = (value) => String(value).replace(/var\((--[\w-]+)\)/g, (all, name) => tokens[name] ?? all);
const luminance = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

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

test('your prompts: Copy shows on hover or focus only (pointer screens), never on touch; the time always shows', () => {
  const css = fs.readFileSync(path.join(APP_DIR, 'chat.css'), 'utf8');
  const block = css.slice(css.indexOf('@media (hover: hover)'));
  assert.match(block, /\.bubble\.user > \.bubble-head > \.copy-ctl \{\s*opacity: 0;/);
  assert.match(block, /\.bubble\.user:hover > \.bubble-head > \.copy-ctl,\s*\.bubble\.user:focus-within > \.bubble-head > \.copy-ctl \{\s*opacity: 1;/);
  assert.doesNotMatch(block.slice(0, block.indexOf('\n}\n')), /time|assistant|visibility/);
});

test('time and Copy always show outside the hover-only media block, time 12px muted with at least 4.5:1 on the purple box', () => {
  const time = { ...decl('.bubble-head time'), ...decl(HEAD + ' > time') };
  assert.equal(time['font-size'], '12px');
  const color = hex(time.color);
  assert.match(color, /^#[0-9a-f]{6}$/i);
  assert.ok(
    contrast(color, '#272031') >= 4.5,
    `time contrast ${contrast(color, '#272031').toFixed(2)} on the user box`,
  );
  assert.ok(contrast(color, hex('var(--bg)')) >= 4.5, 'and on the page behind agent messages');
  for (const part of ['time', '.copy-ctl']) {
    assert.equal(decl(`${HEAD} > ${part}`).opacity, undefined);
    assert.deepEqual(decl(`.bubble.user:hover > .bubble-head > ${part}`), {});
    assert.deepEqual(decl(`.bubble.user:focus-within > .bubble-head > ${part}`), {});
  }
});

test('no page stylesheet hides a message time or a copy / run control until hover', () => {
  const targets = /(?:\btime\b|copy-ctl|copy-message|copy-code|run-term|\.copied)/;
  for (const file of fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.css'))) {
    for (const rule of cssRules(fs.readFileSync(path.join(APP_DIR, file), 'utf8'))) {
      if (!/\.bubble|copy-|run-term|msg-note/.test(rule.selector) || !targets.test(rule.selector)) continue;
      if (rule.context === '@media(hover:hover)' && /^\.bubble\.user(:hover|:focus-within)? > \.bubble-head > \.copy-ctl$/.test(rule.selector)) continue; // your prompts' Copy: hover-only by the owner's choice
      const d = rule.declarations;
      assert.ok(
        !('opacity' in d) || Number(d.opacity) === 1 || /:disabled/.test(rule.selector),
        `${file}: ${rule.selector} sets opacity ${d.opacity}`,
      );
      assert.notEqual(d.visibility, 'hidden', `${file}: ${rule.selector}`);
    }
  }
});

test('Copy, Run in terminal and code-block copy: 12px text, at least 24px tall, the pair the same height', () => {
  const ctl = decl('.copy-ctl'),
    btn = decl('.copy-ctl button'),
    run = decl('.run-term');
  assert.equal(ctl['font-size'], '12px');
  assert.equal(btn['min-height'], '24px');
  assert.equal(ctl.border, '1px solid var(--line)'); // 24px button + 1px border top and bottom = 26px
  assert.equal(run['font-size'], '12px');
  assert.equal(run.height, '26px', 'matches the copy control next to it (border-box)');
  assert.ok(parseInt(run['min-width'], 10) >= 24);
  /* the code-block corner copy is a .copy-ctl too, so it gets the same size, and is not faded */
  assert.equal(decl('.copy-code').opacity, undefined);
});

test('the user rules do not leak to other bubbles', () => {
  const leaks = rules.filter((r) => /\.bubble\.user/.test(r.selector) && /assistant|tool|notice/.test(r.selector));
  assert.equal(leaks.length, 0);
  assert.equal(decl('.bubble-head')['border-bottom'], '1px solid #292b35');
});
