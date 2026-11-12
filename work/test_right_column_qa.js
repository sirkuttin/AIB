'use strict';
/* QA 3 (right column): the artifact viewer never jumps on its own (m2), a comparison survives a new version, old cards keep the
   version their turn wrote (m3), the version menu stays inside the column (m1), and Switch keeps the keyboard focus (m10). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { page, load, APP } = require('./fake_dom.js');
const A = require(path.join(APP, 'artifacts-ui.js'));

const art = (id, title, version, updatedAt, extra) => ({
  id,
  title,
  kind: 'html',
  version,
  versions: version,
  updatedAt,
  url: 'http://a/' + id + '/v' + version + '/',
  ...extra,
});

function viewer() {
  const shell = page({ ids: ['artifactsView'] });
  const w = shell.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.CustomEvent = function (type, init) {
    this.type = type;
    this.detail = init && init.detail;
  };
  w.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      /bootstrap/.test(url)
        ? { token: 't' }
        : /artifacts\/item/.test(url)
          ? { versions: [], url: 'http://a/x/' }
          : /artifacts\/diff/.test(url)
            ? { diff: '' }
            : { artifacts: ctx ? ctx.ArtifactsUI._S.list : [] }, // the list route answers what the page already has
  });
  let ctx = null;
  ctx = load(shell, ['artifacts-ui.js']);
  const UI = ctx.ArtifactsUI;
  const view = shell.byId.artifactsView;
  const tab = shell.document.createElement('button'),
    badge = shell.document.createElement('span');
  UI.mount({ view, badge, tab, win: ctx, reveal() {} });
  UI.sync({ id: 'chat1', busy: false, cwd: '' });
  return { UI, view, shell, ctx, S: UI._S };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test('QA m2: while you look at an artifact a new one does not take over; a quiet "New: <title> · Open" bar offers it', async () => {
  const { UI, view, S } = viewer();
  UI.upsert(art('a1', 'First', 1, 100));
  assert.equal(S.selId, 'a1', 'the first artifact is shown when nothing is');
  UI.setVisible(true);
  UI.upsert(art('b2', 'Second', 1, 200));
  assert.equal(S.selId, 'a1', 'the viewer stays where it is');
  assert.equal(S.fresh, 'b2');
  const bar = view.querySelector('.ar-fresh');
  assert.equal(bar.hidden, false);
  assert.equal(bar.querySelector('.ar-fresh-t').textContent, 'New: Second · ');
  bar.querySelector('.ar-fresh-open').click();
  await flush();
  assert.equal(S.selId, 'b2', 'Open shows it');
  assert.equal(S.fresh, '');
  assert.equal(bar.hidden, true);
});

test('QA m2: out of sight and untouched, the viewer still follows the newest artifact (no bar)', () => {
  const { UI, S } = viewer();
  UI.upsert(art('a1', 'First', 1, 100));
  UI.upsert(art('b2', 'Second', 1, 200));
  assert.equal(S.selId, 'b2');
  assert.equal(S.fresh, '');
});

test('QA m2: a new version during a comparison keeps comparing the same two versions and offers the switch', async () => {
  const { UI, view, S } = viewer();
  UI.upsert(art('a1', 'Page', 2, 100));
  UI.setVisible(true);
  await UI.open('a1', { compare: { from: 1, to: 2 } });
  assert.equal(S.mode, 'compare');
  UI.upsert(art('a1', 'Page', 3, 300));
  assert.equal(S.mode, 'compare', 'the comparison stays open');
  assert.deepEqual({ ...S.cmp }, { from: 1, to: 2 });
  assert.equal(S.picked, 2, 'the chip stays on v2');
  const avail = view.querySelector('.ar-avail');
  assert.equal(avail.hidden, false);
  assert.match(avail.textContent, /v3 is available/);
  avail.querySelector('.ar-switch').click();
  await flush();
  assert.equal(S.picked, null);
  assert.equal(S.mode, 'page');
  assert.equal(
    view.ownerDocument.activeElement,
    view.querySelector('.ar-ver'),
    'QA m10: the focus goes to the version chip',
  );
});

test('QA m3: a write card shows the version that write made', () => {
  const versions = [
    { n: 1, at: 1000 },
    { n: 2, at: 2000.5 },
    { n: 3, at: 3000 },
  ];
  assert.equal(A.writtenVersion(versions, 999.8, 0, 3), 1, 'saved a moment after the write');
  assert.equal(A.writtenVersion(versions, 2000, 0, 3), 2);
  assert.equal(A.writtenVersion(versions, 5000, 0, 3), 3, 'nothing after it: the newest before it');
  assert.equal(A.writtenVersion([], 0, 1, 3), 1, 'no time (a replayed row): the first write card is v1');
  assert.equal(A.writtenVersion([], 0, 5, 3), 3, 'never above the latest');
  const list = [art('a1', 'Demo page', 2, 2000, { sourcePath: 'C:/p/outputs/demo.html' })];
  const old = A.outputsCardModel('C:/p/outputs/demo.html', list, 2000 * 1000, 1);
  assert.equal(old.version, 1);
  assert.equal(old.sub, 'HTML page · v1 · now v2');
  assert.equal(old.diffFrom, null);
  const now = A.outputsCardModel('C:/p/outputs/demo.html', list, 2000 * 1000);
  assert.equal(now.version, 2);
  assert.equal(now.sub, 'HTML page · v2 · updated just now');
});

test('QA m1: a menu wider than the room right of its button moves left, inside the column', () => {
  assert.equal(A.placeLeft(10, 210, 300), 10);
  assert.equal(A.placeLeft(150, 210, 300), 86, 'the menu ends 4 px inside the right edge');
  assert.equal(A.placeLeft(150, 400, 300), 4, 'wider than the column: from its left edge');
});

test('option C: "Built from Release plan › Rollout · Open doc", then "changed after this was built (2 edits)"; Rebuild sends the message', async () => {
  const { UI, view, shell, ctx } = viewer();
  let built = { doc: 'release-plan', title: 'Release plan', page: 'p2', pageTitle: 'Rollout', changed: false, edits: 0 };
  const realFetch = ctx.fetch;
  ctx.fetch = async (url, init) =>
    /docs\/built/.test(url) ? { ok: true, status: 200, json: async () => ({ ok: true, built }) } : realFetch(url, init);
  const fromDoc = { doc: 'release-plan', title: 'Release plan', page: 'p2', pageTitle: 'Rollout', rev: 4 };
  UI.upsert(art('a1', 'Checkout v2 timeline', 1, 100, { fromDoc }));
  await flush();
  const banner = view.querySelector('.ar-built');
  assert.equal(banner.hidden, false);
  assert.equal(banner.querySelector('.ar-built-t').textContent, 'Built from Release plan \u203a Rollout \u00b7 ');
  assert.equal(banner.querySelector('.ar-built-open').textContent, 'Open doc \u2197');
  assert.equal(view.querySelector('.ar-stale').hidden, true, 'not changed: no rebuild line');
  // the page changes: the stale line and its button
  built = Object.assign({}, built, { changed: true, edits: 2 });
  UI.upsert(art('a1', 'Checkout v2 timeline', 2, 200, { fromDoc }));
  await flush();
  const stale = view.querySelector('.ar-stale');
  assert.equal(stale.hidden, false);
  assert.equal(stale.querySelector('.ar-built-t').textContent, 'Release plan \u203a Rollout changed after this was built (2 edits). ');
  // Rebuild from the doc: a normal message in the composer, sent
  const form = shell.document.createElement('form');
  form.id = 'promptForm';
  const box = shell.document.createElement('textarea');
  box.id = 'prompt';
  shell.document.body.append(form, box);
  const byId = ctx.document.getElementById.bind(ctx.document);
  ctx.document.getElementById = (id) => (id === 'prompt' ? box : id === 'promptForm' ? form : byId(id));
  let sent = null;
  form.requestSubmit = () => {
    sent = box.value;
  };
  stale.querySelector('.ar-rebuild').click();
  assert.equal(sent, 'Rebuild Checkout v2 timeline from Release plan \u203a Rollout.');
  // a draft in the box is never replaced
  sent = null;
  box.value = 'my draft';
  stale.querySelector('.ar-rebuild').click();
  assert.equal(sent, null);
  assert.equal(box.value, 'my draft');
  assert.match(view.querySelector('.ar-note').textContent, /Send or clear your draft first/);
  // no link: no banner
  UI.upsert(art('b1', 'Other', 1, 300));
  await UI.open('b1');
  await flush();
  assert.equal(view.querySelector('.ar-built').hidden, true);
});

test('option C: builtBanner and the card line name the doc page', () => {
  const a = { id: 'a', title: 'Timeline', fromDoc: { doc: 'p', title: 'Release plan', page: 'x', pageTitle: 'Rollout', rev: 1 } };
  assert.equal(A.builtBanner({ id: 'b' }, null), null);
  assert.deepEqual(JSON.parse(JSON.stringify(A.builtBanner(a, null))), { from: 'Release plan \u203a Rollout', stale: false, line: '', rebuild: '' });
  const st = A.builtBanner(a, { title: 'Plan', pageTitle: 'Dates', changed: true, edits: 1 });
  assert.equal(st.line, 'Plan \u203a Dates changed after this was built (1 edit).');
  assert.equal(st.rebuild, 'Rebuild Timeline from Plan \u203a Dates.');
  assert.equal(A.builtBanner(a, { gone: 'page' }).gone, 'page');
  const m = A.cardModel({ op: 'publish', input: {}, result: { id: 'a', version: 1 }, status: 'completed' }, [Object.assign({ kind: 'html', version: 1 }, a)]);
  assert.equal(A.cardLine(m), 'Artifact \u00b7 HTML page \u00b7 v1 \u00b7 built from Release plan \u203a Rollout');
});
