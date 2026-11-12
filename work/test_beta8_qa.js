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

test('no Docs tab styles are left: docs live in Files (no .dt-* or Docs pane rules); the live dot on a doc row stops for reduced motion', () => {
  const rules = css('files.css');
  const left = rules.filter((r) => /\.dt-|\.sf-docs|#docsPane|sf-docs-mode|fx-docsfolder/.test(r.selector)).map((r) => r.selector);
  assert.deepEqual(left, []);
  assert.equal(declarationsFor(rules, '.fx-docdot')['border-radius'], '50%');
  const calm = rules.find((r) => r.selector === '.fx-docdot' && /reduce/.test(r.context));
  assert.equal(calm && calm.declarations.animation, 'none');
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

test('the Artifacts viewer shows a doc from the chat in a frame; an agent-made doc is only announced (count, marked row); an artifact replaces the doc', async () => {
  const shell = page({ ids: ['artifactsView'] });
  const w = shell.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 't', artifacts: [] }) });
  const ctx = load(shell, ['artifacts-ui.js']);
  ctx.location = { origin: 'http://127.0.0.1:9' };
  const UI = ctx.ArtifactsUI;
  const badge = shell.document.createElement('span'),
    tab = shell.document.createElement('button');
  let reveals = 0;
  UI.mount({ view: shell.byId.artifactsView, badge, tab, win: ctx, reveal: () => reveals++ });
  UI.sync({ id: 'chat1', busy: false, cwd: '' });
  UI.setVisible(true);
  // an agent made it: announced, not opened, no reveal
  assert.equal(UI.openDoc({ name: 'launch-notes', title: 'Launch notes' }, { chat: 'chat1', background: true }), true);
  assert.equal(UI.state().doc, null);
  assert.equal(UI.state().fresh, 'doc:launch-notes');
  assert.equal(reveals, 0);
  assert.equal(badge.textContent, '1');
  assert.match(tab.getAttribute('aria-label'), /1 doc.*new/);
  const row = shell.byId.artifactsView.querySelector('.ar-doc');
  assert.ok(row && row.classList.contains('ar-new') && row.querySelector('.ar-newdot'), 'the row is marked new');
  assert.ok(!row.textContent.includes('\u2197'), 'no arrow on the row');
  // another chat's doc is not shown here
  assert.equal(UI.openDoc({ name: 'x' }, { chat: 'chat2' }), false);
  // clicked: shown in a frame, revealed, the mark goes
  row.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(UI.state().doc.name, 'launch-notes');
  assert.equal(UI.state().fresh, '');
  assert.equal(reveals, 1);
  const frame = shell.byId.artifactsView.querySelector('iframe.ar-docframe');
  assert.ok(frame, 'the doc frame');
  assert.equal(shell.byId.artifactsView.querySelector('.ar-ver').hidden, true, 'no version chip for a doc');
  // an artifact replaces the doc
  UI.upsert({ id: 'a1', title: 'First', kind: 'html', version: 1, versions: 1, updatedAt: 1, url: 'http://a/a1/v1/', conversationId: 'chat1' });
  assert.equal(badge.textContent, '2', 'the count is artifacts plus docs');
  await UI.open('a1');
  assert.equal(UI.state().doc, null);
  assert.equal(shell.byId.artifactsView.querySelector('iframe.ar-docframe'), null, 'the doc frame is gone');
});
