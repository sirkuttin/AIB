'use strict';
/* AIB beta.8 QA fixes on the docs screens: the doc card stays in the chat, the Artifacts bar keeps the picker readable at the
   default column width, the colour menu swatches each have their own colour, the doc tab icon is 14 px, the doc beside the chat
   folds its toolbar, the outlined Open doc button, the light info callout, the 3 columns icon. Fake DOM and CSS rules, no browser
   (the browser side is in work/deno/doc_page_e2e_test.ts). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page, load, APP } = require('./fake_dom.js');
const { cssRules, declarationsFor } = require('./css_rules.js');

const css = (name) => cssRules(fs.readFileSync(path.join(APP, name), 'utf8'));
const px = (v) => parseFloat(String(v));

test('the doc card (class doc-card, no data-src or data-op) stays when the Artifacts tab paints cards', () => {
  const shell = page({ ids: ['artifactsView'] });
  const w = shell.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.CustomEvent = function (type, init) {
    this.type = type;
    this.detail = init && init.detail;
  };
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 't', artifacts: [] }) });
  const ctx = load(shell, ['artifacts-ui.js']);
  const UI = ctx.ArtifactsUI;
  const card = shell.document.createElement('div');
  card.className = 'art-card doc-card';
  const title = shell.document.createElement('div');
  title.className = 'art-card-title';
  card.append(title);
  shell.body.append(card);
  UI.mount({ view: shell.byId.artifactsView, badge: shell.document.createElement('span'), tab: shell.document.createElement('button'), win: ctx, reveal() {} });
  UI.sync({ id: 'chat1', busy: false, cwd: '' });
  UI.setVisible(true);
  UI.upsert({ id: 'a1', title: 'First', kind: 'html', version: 1, versions: 1, updatedAt: 1, url: 'http://a/a1/v1/' });
  assert.equal(card.hidden, false, 'the doc card is not hidden');
  assert.equal(card.children.length, 1, 'its content is not wiped');
});

test('Artifacts bar: the picker keeps at least 140 px and its row wraps, so the word buttons drop below at 280 px', () => {
  const rules = css('artifacts.css');
  const pick = declarationsFor(rules, '.ar-pick');
  assert.ok(px(pick['min-width']) >= 140, 'picker min-width ' + pick['min-width']);
  assert.equal(declarationsFor(rules, '.ar-bar')['flex-wrap'], 'wrap');
  assert.equal(declarationsFor(rules, '.ar-word')['flex'], '0 0 auto', 'the word buttons never squeeze the picker');
});

test('Open doc on the doc card is an outlined button: accent border and text, no fill', () => {
  const d = declarationsFor(css('artifacts.css'), '.art-btn.art-btn-acc');
  assert.equal(d['border-color'], 'var(--accent)');
  assert.equal(d.color, 'var(--accent)');
  assert.equal(d.background, 'transparent');
});

test('colour menu: every text swatch has its own colour rule that beats .cpop .sw2, from the theme tokens', () => {
  const rules = css('docs.css');
  const base = declarationsFor(rules, '.cpop .sw2');
  assert.equal(base.color, 'var(--text)');
  const colours = ['grey', 'red', 'orange', 'green', 'blue', 'purple'].map((c) => declarationsFor(rules, '.cpop .sw2.tc-' + c).color);
  for (const c of colours) assert.match(c, /^var\(--[a-z-]+\)$/);
  assert.equal(new Set(colours).size, 6, 'six different tokens: ' + colours.join(' '));
  assert.ok(!colours.includes('var(--text)'));
  // the ring only for the pressed swatch
  assert.match(declarationsFor(rules, ".cpop .sw2[aria-pressed='true']")['box-shadow'], /var\(--accent\)/);
});

test('the doc tab icon in the workspace strip is 14 px like the other tab icons', () => {
  const d = declarationsFor(css('files.css'), '.sf-ftab .ws-tab-main .sf-docico');
  assert.equal(d.width, '14px');
  assert.equal(d.height, '14px');
});

test('Docs tab empty state is centred', () => {
  const d = declarationsFor(css('files.css'), '.dt-empty');
  assert.equal(d['align-items'], 'center');
  assert.equal(d['text-align'], 'center');
});

test('beside the chat (.narrow) the toolbar folds into ⋯ and never scrolls sideways; the header shows the doc name', () => {
  const rules = css('docs.css');
  assert.equal(declarationsFor(rules, '.narrow .tbar .tb-fold').display, 'none');
  assert.equal(declarationsFor(rules, '.tbar .tb-more').display, 'none');
  assert.equal(declarationsFor(rules, '.narrow .tbar .tb-more').display, 'inline-flex');
  assert.equal(declarationsFor(rules, '.narrow .tbar')['overflow-x'], 'hidden');
  assert.notEqual(declarationsFor(rules, '.narrow .crumbs').display, 'none', 'the crumbs stay in the narrow header');
  assert.equal(declarationsFor(rules, '.crumbs')['text-overflow'], 'ellipsis');
});

test('the comments panel edge is the app\'s normal border and shadow, not a heavy side shadow', () => {
  const d = declarationsFor(css('docs.css'), '.rail-overlay');
  assert.equal(d['box-shadow'], '0 8px 22px var(--shadow-med)');
  assert.ok(d['border-left']);
});

test('light themes tint the info callout blue from --info (stronger than the dark mix)', () => {
  const rules = css('theme.css');
  const light = rules.filter((r) => r.declarations['--co-info-bg'] && /light/.test(r.selector));
  assert.equal(light.length, 4, 'teal, high-contrast, GitHub and Solarized light');
  for (const r of light) {
    assert.match(r.declarations['--co-info-bg'], /var\(--info\) 1[2-9]%/);
    assert.match(r.declarations['--co-info-line'], /var\(--info\)/);
  }
});

test('3 columns has its own icon', () => {
  const I = require(path.join(APP, 'doc-icons.js'));
  assert.ok(I.names.includes('columns3'));
  const src = fs.readFileSync(path.join(APP, 'doc-toolbar.js'), 'utf8');
  assert.match(src, /id: 'columns3',\s*label: '3 columns',\s*icon: 'columns3'/);
  assert.ok(!/Teal and blue are left out/.test(src), 'the agents note is gone');
});
