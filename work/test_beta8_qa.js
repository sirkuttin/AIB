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

test('Artifacts bar: one row (lead decision 2026-11-16); the picker gives way, the word buttons never squeeze it', () => {
  // superseded beta.8 rule: the picker kept 140 px and the row wrapped (three rows, 109 px, at 280 px). The browser check of the
  // one row at every width is work/deno/artifact_toolbar_e2e_test.ts.
  const rules = css('artifacts.css');
  assert.equal(declarationsFor(rules, '.ar-bar')['flex-wrap'], 'nowrap');
  assert.equal(px(declarationsFor(rules, '.ar-pick')['min-width']), 0);
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

test('the Docs tab lists the project docs newest first with a writing chip and a new mark; a click opens the doc in a frame (no count); the Artifacts tab keeps no docs', async () => {
  const shell = page({ ids: ['docsView'] });
  const w = shell.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.setTimeout = () => 1;
  const ctx = load(shell, ['docs-tab-ui.js']);
  const UI = ctx.AgentDocsTabUI;
  const docs = [
    { name: 'old', title: 'Old doc', pages: 1, editedAt: 1000, editedBy: 'Codex', chat: 'chat1' },
    { name: 'launch-notes', title: 'Launch notes', pages: 3, editedAt: 5000, editedBy: 'Claude Code', chat: 'chat1', writing: [{ chat: 'claude:a', name: 'Claude Code', page: 'Overview', section: 'Risks' }] },
  ];
  const listeners = [];
  ctx.AgentDocLinks = {
    cached: () => docs,
    listFor: async () => docs,
    onList: (fn) => listeners.push(fn),
    docUrl: (o) => '/doc.html?chat=' + o.chat + '&name=' + o.name + '&where=' + o.where,
  };
  ctx.AgentFilesUI = { attachDocFrame: () => ({ detach() {} }) };
  const tab = shell.document.createElement('button'),
    dot = shell.document.createElement('span');
  let reveals = 0;
  UI.mount({ view: shell.byId.docsView, dot, tab, win: ctx, reveal: () => reveals++ });
  UI.sync({ id: 'chat1', project: 'p1' });
  UI.setVisible(true);
  // newest edited first; the writing chip names the agent; the tab's dot is on (no count anywhere)
  const rows = () => shell.byId.docsView.querySelectorAll('.dt-row');
  assert.deepEqual(rows().map((r) => r.dataset.doc), ['launch-notes', 'old']);
  assert.equal(rows()[0].querySelector('.dt-writing').textContent, 'Claude Code writing');
  assert.equal(rows()[1].querySelector('.dt-writing'), null);
  assert.equal(dot.hidden, false, 'the live dot');
  assert.ok(shell.byId.docsView.querySelector('.dt-newrow'), 'a + New doc row');
  assert.deepEqual(UI.sortDocs(docs).map((d) => d.name), ['launch-notes', 'old']);
  assert.equal(UI.metaText(docs[1], 6000), '3 pages \u00b7 edited by Claude Code \u00b7 just now');
  assert.equal(UI.metaText(docs[0], 1000 + 5 * 60000), '1 page \u00b7 edited by Codex \u00b7 5 min ago');
  // an agent made one while you watch: marked new, nothing opens, nothing is revealed
  assert.equal(UI.open({ name: 'fresh', title: 'Fresh' }, { background: true }), true);
  assert.equal(UI.state().doc, null);
  assert.equal(reveals, 0);
  // a click opens it in the panel: revealed, in a frame, the list gone, ← Docs and ⤢ there
  rows()[0].click();
  assert.equal(UI.state().doc.name, 'launch-notes');
  assert.equal(reveals, 1);
  const frame = shell.byId.docsView.querySelector('iframe.dt-frame');
  assert.ok(frame && /where=docs/.test(frame.src), 'the doc frame');
  assert.equal(shell.byId.docsView.querySelector('.dt-list').hidden, true);
  assert.equal(shell.byId.docsView.querySelector('.dt-bar').hidden, false);
  assert.equal(shell.byId.docsView.querySelector('.dt-wide').textContent, '\u2922');
  // another chat of the project: the open doc stays; ← Docs closes it
  UI.sync({ id: 'chat2', project: 'p1' });
  assert.equal(UI.state().doc.name, 'launch-notes');
  assert.equal(shell.byId.docsView.querySelector('iframe.dt-frame'), frame, 'the same frame');
  shell.byId.docsView.querySelector('.dt-back').click();
  assert.equal(UI.state().doc, null);
  assert.equal(shell.byId.docsView.querySelector('iframe.dt-frame'), null);
});
