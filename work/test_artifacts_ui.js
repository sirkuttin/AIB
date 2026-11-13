'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
const APP = APP_DIR;
require(path.join(APP, 'tool-views.js'));
const A = require(path.join(APP, 'artifacts-ui.js'));
const { pageAssets } = require('./chat_harness.js');
const C = require(path.join(APP, 'changes-ui.js'));
const NOW = 1794175000 * 1000;
const art = (o) =>
  Object.assign(
    {
      id: '3f9c0a1b2c3d4e5f',
      title: 'Drop rates by tier',
      kind: 'html',
      version: 2,
      versions: 2,
      updatedAt: 1794175000,
      pinned: false,
      sourcePath: null,
      conversationId: 'c1',
    },
    o,
  );

/* ---- picker ---- */
test('picker orders pinned first, then newest first, and groups them', () => {
  const list = [
    art({ id: 'a', title: 'Old', updatedAt: 100 }),
    art({ id: 'b', title: 'New', updatedAt: 300 }),
    art({ id: 'c', title: 'Pinned old', updatedAt: 50, pinned: true }),
    art({ id: 'd', title: 'Mid', updatedAt: 200 }),
  ];
  assert.deepEqual(
    A.orderArtifacts(list).map((a) => a.id),
    ['c', 'b', 'd', 'a'],
  );
  const g = A.pickerGroups(list, 'b', NOW);
  assert.deepEqual(
    g.map((x) => x.label),
    ['Pinned', 'This chat'],
  );
  assert.deepEqual(
    g[1].items.map((i) => i.id),
    ['b', 'd', 'a'],
  );
  assert.equal(g[1].items[0].on, true);
  assert.equal(g[0].items[0].pinned, true);
  assert.deepEqual(
    A.pickerGroups([art({ id: 'x' })], 'x', NOW).map((x) => x.label),
    ['This chat'],
  );
  assert.deepEqual(A.pickerGroups([], '', NOW), []);
});
test('picker rows carry a kind badge and "v2 · just now" meta', () => {
  const r = A.pickerGroups([art({ kind: 'image' })], '', NOW)[0].items[0];
  assert.equal(r.badge, 'img');
  assert.equal(r.meta, 'v2 \u00b7 just now');
  assert.equal(A.kindInfo('md').badge, 'md');
  assert.equal(A.kindInfo('json').name, 'JSON');
});
test('one artifact makes the picker plain text, several make a dropdown', () => {
  assert.equal(A.pickerIsPlain([art()]), true);
  assert.equal(A.pickerIsPlain([]), true);
  assert.equal(A.pickerIsPlain([art(), art({ id: 'z' })]), false);
});
test('relative times read naturally', () => {
  const at = NOW / 1000;
  assert.equal(A.relTime(at - 5, NOW), 'just now');
  assert.equal(A.relTime(at - 20 * 60, NOW), '20 min ago');
  assert.equal(A.relTime(at - 3600, NOW), '1 h ago');
  assert.equal(A.relTime(at - 26 * 3600, NOW), 'yesterday');
  assert.equal(A.relTime(at - 3 * 86400, NOW), '3 d ago');
  assert.equal(A.relTime(0, NOW), '');
});

/* ---- versions ---- */
test('version chip: plain for one version, a dropdown for several, flags an old version', () => {
  assert.deepEqual(A.chipState({ latest: 1, count: 1 }), {
    shown: 1,
    latest: 1,
    plain: true,
    old: false,
    following: true,
    text: 'v1',
  });
  const c = A.chipState({ latest: 3, count: 3, picked: null });
  assert.equal(c.text, 'v3 \u25be');
  assert.equal(c.plain, false);
  assert.equal(c.old, false);
  const old = A.chipState({ latest: 3, count: 3, picked: 1 });
  assert.equal(old.text, 'v1 \u25be');
  assert.equal(old.old, true);
  assert.equal(old.following, false);
  assert.equal(
    A.chipState({ latest: 3, count: [{}, {}, {}], picked: 9 }).shown,
    3,
    'a pick beyond the latest is ignored',
  );
  assert.equal(A.shownVersion(5, null), 5);
  assert.equal(A.shownVersion(5, 2), 2);
  assert.equal(A.shownVersion(5, 0), 5);
});
test('"v3 is available · Switch" shows only while an older version is picked', () => {
  assert.equal(A.availability({ latest: 3, picked: null }), null);
  assert.equal(A.availability({ latest: 3, picked: 3 }), null);
  assert.deepEqual(A.availability({ latest: 3, picked: 1 }), { text: 'v3 is available', action: 'Switch', target: 3 });
});
test('version list is newest first and marks the latest and the shown one', () => {
  const rows = A.versionRows(
    [
      { n: 1, at: NOW / 1000 - 3600, by: 'tool' },
      { n: 2, at: NOW / 1000 - 5, by: 'watch', note: 'tweak' },
    ],
    2,
    1,
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => [r.label, r.latest, r.on]),
    [
      ['v2', true, false],
      ['v1', false, true],
    ],
  );
  assert.equal(rows[0].meta, 'just now \u00b7 file change \u00b7 latest');
  assert.equal(rows[0].note, 'tweak');
  assert.equal(rows[1].meta, '1 h ago \u00b7 agent');
});

/* ---- menu ---- */
const ids = (items) => items.map((i) => (i.sep ? '|' : i.id));
test('menu on the latest version of a page with a source file', () => {
  assert.deepEqual(
    ids(A.menuItems({ kind: 'html', shown: 2, latest: 2, sourcePath: 'C:\\p\\a.html', canEditor: true })),
    ['source', 'compare', '|', 'pin', 'editor', 'copy', 'download', '|', 'archive', 'delete'],
  );
  assert.equal(A.menuItems({ kind: 'html', shown: 2, latest: 2 })[1].label, 'Compare with v1');
});
test('restore appears only on an old version, and compare needs a previous one', () => {
  assert.deepEqual(ids(A.menuItems({ kind: 'html', shown: 1, latest: 3 })), [
    'source',
    'restore',
    '|',
    'pin',
    'download',
    '|',
    'archive',
    'delete',
  ]);
  assert.ok(ids(A.menuItems({ kind: 'html', shown: 2, latest: 3 })).includes('restore'));
  assert.equal(
    A.menuItems({ kind: 'html', shown: 2, latest: 3 }).find((i) => i.id === 'compare').label,
    'Compare with v1',
  );
  assert.ok(!ids(A.menuItems({ kind: 'html', shown: 1, latest: 1 })).includes('compare'));
});
test('no source path hides editor and copy; no editor hides the editor item; pinned says Unpin', () => {
  assert.deepEqual(ids(A.menuItems({ kind: 'svg', shown: 1, latest: 1, sourcePath: null, canEditor: true })), [
    'source',
    '|',
    'pin',
    'download',
    '|',
    'archive',
    'delete',
  ]);
  assert.ok(
    !ids(A.menuItems({ kind: 'svg', shown: 1, latest: 1, sourcePath: '/a.svg', canEditor: false })).includes('editor'),
  );
  assert.ok(
    ids(A.menuItems({ kind: 'svg', shown: 1, latest: 1, sourcePath: '/a.svg', canEditor: false })).includes('copy'),
  );
  const pin = A.menuItems({ kind: 'svg', shown: 1, latest: 1, pinned: true }).find((i) => i.id === 'pin');
  assert.equal(pin.label, 'Unpin');
  assert.equal(A.menuItems({ kind: 'svg', shown: 1, latest: 1 }).find((i) => i.id === 'pin').label, 'Pin');
});
test('menu per kind: text kinds have no View source, pictures and PDFs no source or compare', () => {
  assert.deepEqual(ids(A.menuItems({ kind: 'csv', shown: 2, latest: 2 })), ['compare', '|', 'pin', 'download', '|', 'archive', 'delete']);
  assert.deepEqual(ids(A.menuItems({ kind: 'image', shown: 3, latest: 3 })), ['pin', 'download', '|', 'archive', 'delete']);
  assert.deepEqual(ids(A.menuItems({ kind: 'pdf', shown: 2, latest: 2 })), ['pin', 'download', '|', 'archive', 'delete']);
  assert.equal(A.menuItems({ kind: 'html', shown: 1, latest: 1, mode: 'source' })[0].label, 'View page');
  assert.equal(
    A.menuItems({ kind: 'html', shown: 2, latest: 2, mode: 'compare' }).find((i) => i.id === 'compare').label,
    'Close comparison',
  );
});

/* ---- frames and sandbox ---- */
test('pages get the exact sandbox; PDFs are unsandboxed; pictures and text have no frame', () => {
  assert.equal(A.SANDBOX, 'allow-scripts allow-forms allow-popups allow-downloads');
  for (const k of ['html', 'svg', 'md']) assert.deepEqual(A.frameSpec(k), { tag: 'iframe', sandbox: A.SANDBOX });
  assert.deepEqual(A.frameSpec('pdf'), { tag: 'iframe', sandbox: null });
  assert.equal(A.frameSpec('image').tag, 'img');
  for (const k of ['csv', 'json', 'text']) assert.equal(A.frameSpec(k).tag, 'pre');
});
test('no kind of artifact is ever framed with the same-origin or top-navigation allowance', () => {
  assert.deepEqual(A.SANDBOX.split(/\s+/).sort(), ['allow-downloads', 'allow-forms', 'allow-popups', 'allow-scripts']);
  for (const kind of [...Object.keys(A.KINDS), 'unknown-kind', '']) {
    for (const token of String(A.frameSpec(kind).sandbox || '').split(/\s+/))
      assert.ok(!/^allow-(same-origin|top-navigation)/.test(token), kind + ': ' + token);
  }
});
test('markdown pages load through ?view=1; the scroll position rides in the hash', () => {
  assert.equal(A.viewUrl('md', 'http://127.0.0.1:8768/a/x/v1/n.md'), 'http://127.0.0.1:8768/a/x/v1/n.md?view=1');
  assert.equal(A.viewUrl('html', 'http://h/a/x/v1/p.html'), 'http://h/a/x/v1/p.html');
  assert.equal(
    A.withScroll('http://h/a/x/v1/p.html', { x: 3.4, y: 120.6 }),
    'http://h/a/x/v1/p.html#studio-scroll=3,121',
  );
  assert.equal(A.withScroll('http://h/p.html#old', { x: 0, y: 0 }), 'http://h/p.html#old');
  assert.equal(A.withScroll('http://h/p.html', null), 'http://h/p.html');
  assert.equal(A.downloadUrl('http://h/a/x/v1/p.html#s'), 'http://h/a/x/v1/p.html?download=1');
  assert.equal(
    A.downloadUrl('http://h/p?view=1'),
    'http://h/p?download=1'.replace('?download=1', '?view=1&download=1'),
  );
  assert.equal(A.versionUrlFrom('http://h/a/x/v3/p.html', 1), 'http://h/a/x/v1/p.html');
});

/* ---- links ---- */
test('studio-artifact links are recognised', () => {
  assert.equal(A.artifactIdFromLink('studio-artifact://3F9C0A1B2C3D4E5F'), '3f9c0a1b2c3d4e5f');
  assert.equal(A.artifactIdFromLink('studio-artifact://3f9c0a1b2c3d4e5f/'), '3f9c0a1b2c3d4e5f');
  for (const bad of ['https://x', 'studio-artifact://', 'studio-artifact://zz', 'studio-artifact://../etc', null, ''])
    assert.equal(A.artifactIdFromLink(bad), null);
  assert.equal(A.linkLabel('Drop rates', 'x', art()), '\u29c9 Drop rates');
  assert.equal(A.linkLabel('', 'x', art()), '\u29c9 Drop rates by tier');
});
const P = 'C:\\REPOS\\proj';
const files = [
  art({ id: 'a1', sourcePath: 'C:\\REPOS\\proj\\outputs\\drop_rates.csv', kind: 'csv' }),
  art({ id: 'b2', sourcePath: 'C:\\REPOS\\proj\\outputs\\report.html' }),
];
const kinds = (segs) => segs.map((s) => (s.t === 'link' ? '[' + s.v + '>' + s.id + ']' : s.v)).join('');
test('source paths in plain text become links, absolute or relative to the project, either slash style', () => {
  assert.equal(
    kinds(A.linkSegments('The raw numbers are in outputs/drop_rates.csv now.', files, P)),
    'The raw numbers are in [outputs/drop_rates.csv>a1] now.',
  );
  assert.equal(kinds(A.linkSegments('see outputs\\report.html.', files, P)), 'see [outputs\\report.html>b2].');
  assert.equal(
    kinds(A.linkSegments('open C:\\REPOS\\proj\\outputs\\report.html please', files, P)),
    'open [C:\\REPOS\\proj\\outputs\\report.html>b2] please',
  );
  assert.equal(
    kinds(A.linkSegments('C:/REPOS/proj/outputs/drop_rates.csv', files, P)),
    '[C:/REPOS/proj/outputs/drop_rates.csv>a1]',
  );
  assert.equal(
    kinds(A.linkSegments('both outputs/report.html and outputs/drop_rates.csv', files, P)),
    'both [outputs/report.html>b2] and [outputs/drop_rates.csv>a1]',
  );
});
test('only whole paths link: not a longer name, not a different folder, nothing without artifacts', () => {
  assert.equal(A.hasLink(A.linkSegments('outputs/drop_rates.csv.bak', files, P)), false);
  assert.equal(A.hasLink(A.linkSegments('my_outputs/drop_rates.csv', files, P)), false);
  assert.equal(A.hasLink(A.linkSegments('other/outputs/drop_rates.csv', files, P)), false);
  assert.equal(A.hasLink(A.linkSegments('outputs/drop_rates.csvx', files, P)), false);
  assert.equal(A.hasLink(A.linkSegments('outputs/drop_rates.csv', [art({ sourcePath: null })], P)), false);
  assert.deepEqual(A.linkSegments('', files, P), [{ t: 'text', v: '' }]);
  assert.equal(
    kinds(A.linkSegments('(outputs/drop_rates.csv), done', files, P)),
    '([outputs/drop_rates.csv>a1]), done',
  );
});
test('path helpers: relative to the project, outputs folder, case and slashes', () => {
  assert.equal(A.relPath('C:\\REPOS\\proj\\outputs\\a.html', P), 'outputs\\a.html');
  assert.equal(A.relPath('c:/repos/PROJ/x.txt', 'C:\\REPOS\\proj'), 'x.txt');
  assert.equal(A.relPath('C:\\REPOS\\other\\x.txt', P), null);
  assert.equal(A.relPath('C:\\REPOS\\project2\\x.txt', P), null);
  assert.equal(A.isOutputsPath('C:\\REPOS\\proj\\outputs\\a.html', P), true);
  assert.equal(A.isOutputsPath('C:\\REPOS\\proj\\docs\\a.html', P), false);
  assert.equal(A.sameFile('C:\\A\\b.html', 'c:/a/B.html'), true);
  assert.equal(A.absolutize('outputs/a.html', P), 'C:\\REPOS\\proj\\outputs\\a.html');
  assert.equal(A.absolutize('C:\\x\\a.html', P), 'C:\\x\\a.html');
  assert.equal(A.absolutize('/home/me/a.html', '/home/me'), '/home/me/a.html');
});

/* markdown.js: studio-artifact links render as ⧉ links, never as plain external links */
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this._text = '';
    this.className = '';
    this.dataset = {};
    this.attrs = {};
  }
  append(...n) {
    for (const x of n) this.children.push(x);
  }
  replaceChildren(...n) {
    this.children = [...n];
    this._text = '';
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  walk(fn) {
    fn(this);
    for (const c of this.children) c.walk(fn);
  }
  find(tag) {
    const out = [];
    this.walk((n) => {
      if (n.tagName === tag.toUpperCase()) out.push(n);
    });
    return out;
  }
}
test('markdown renders [Title](studio-artifact://id) as an artifact link and leaves other schemes alone', () => {
  const window = {};
  const context = vm.createContext({ document: { createElement: (t) => new Node(t) }, window, URL, console });
  vm.runInContext(fs.readFileSync(path.join(APP, 'markdown.js'), 'utf8'), context);
  const box = new Node('div');
  window.AgentMarkdown.render(
    box,
    'Updated [Drop rates](studio-artifact://3f9c0a1b2c3d4e5f) and [web](https://example.org) and [bad](javascript:alert(1)) and [x](studio-artifact://nothex).',
  );
  const links = box.find('a');
  assert.equal(links.length, 2);
  const a = links[0];
  assert.equal(a.className, 'artifact-link');
  assert.equal(a.dataset.artifactId, '3f9c0a1b2c3d4e5f');
  assert.equal(a.href, '#');
  assert.equal(a.textContent, '\u29c9 Drop rates');
  assert.equal(links[1].href, 'https://example.org/');
  assert.equal(links[1].target, '_blank');
  assert.ok(box.textContent.includes('[bad](javascript:alert(1))'));
  assert.ok(box.textContent.includes('[x](studio-artifact://nothex)'));
});

/* ---- tool rows ---- */
const rawRow = (over) => ({
  role: 'tool',
  raw: Object.assign(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      status: 'completed',
      kind: 'other',
      title: 'studio_artifact: publish',
      _meta: { claudeCode: { toolName: 'mcp__studio_artifact__publish' } },
      rawInput: { title: 'Drop rates by tier', path: 'outputs/drop_rates.html' },
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              id: '3f9c0a1b2c3d4e5f',
              version: 2,
              link: 'studio-artifact://3f9c0a1b2c3d4e5f',
              url: 'http://127.0.0.1:8768/a/x/v2/p.html',
            }),
          },
        },
      ],
    },
    over,
  ),
});
test('a studio_artifact publish row is detected from the tool name, with its result', () => {
  const c = A.artifactCall(rawRow());
  assert.equal(c.op, 'publish');
  assert.equal(c.input.title, 'Drop rates by tier');
  assert.equal(c.result.id, '3f9c0a1b2c3d4e5f');
  assert.equal(c.result.version, 2);
});
test('detection also works from the title, an update op, a saved-history call row and a plain-text result', () => {
  const byTitle = A.artifactCall(rawRow({ _meta: undefined, title: 'studio_artifact.update' }));
  assert.equal(byTitle.op, 'update');
  const saved = A.artifactCall({
    role: 'tool',
    call: {
      name: 'mcp__studio_artifact__update',
      input: { id: '3f9c0a1b2c3d4e5f', path: 'a.html' },
      result: {
        text: '{"id":"3f9c0a1b2c3d4e5f","version":3,"link":"studio-artifact://3f9c0a1b2c3d4e5f"}',
        isError: false,
      },
    },
  });
  assert.equal(saved.op, 'update');
  assert.equal(saved.result.version, 3);
  assert.equal(saved.status, 'completed');
  const wrapped = A.artifactCall(
    rawRow({
      content: undefined,
      rawOutput: { content: [{ type: 'text', text: 'Published: {"id":"aaaaaaaaaaaaaaaa","version":1}' }] },
    }),
  );
  assert.equal(wrapped.result.id, 'aaaaaaaaaaaaaaaa');
  const pending = A.artifactCall(rawRow({ status: 'in_progress', content: undefined }));
  assert.equal(pending.result, null);
});
test('other tools are not artifact calls, and list calls give no card', () => {
  assert.equal(
    A.artifactCall({
      role: 'tool',
      raw: {
        title: 'Read file',
        kind: 'read',
        _meta: { claudeCode: { toolName: 'Read' } },
        rawInput: { file_path: 'a.js' },
      },
    }),
    null,
  );
  assert.equal(
    A.artifactCall({ role: 'tool', call: { name: 'Bash', input: { command: 'ls studio_artifact' } } }),
    null,
  );
  const list = A.artifactCall(
    rawRow({ _meta: { claudeCode: { toolName: 'mcp__studio_artifact__list' } }, title: 'studio_artifact: list' }),
  );
  assert.equal(list.op, 'list');
  assert.equal(A.cardModel(list, [], NOW), null);
});
test('the card shows kind badge, title, "HTML page · v2 · updated just now" and Diff from v1 on updates', () => {
  const c = A.artifactCall(rawRow());
  const m = A.cardModel(c, [art({ version: 2 })], NOW);
  assert.equal(m.badge, 'html');
  assert.equal(m.title, 'Drop rates by tier');
  assert.equal(m.sub, 'HTML page \u00b7 v2 \u00b7 updated just now');
  assert.equal(m.diffFrom, 1);
  assert.equal(m.canOpen, true);
  const first = A.cardModel(
    A.artifactCall(
      rawRow({
        content: [{ type: 'content', content: { type: 'text', text: '{"id":"3f9c0a1b2c3d4e5f","version":1}' } }],
      }),
    ),
    [],
    NOW,
  );
  assert.equal(first.diffFrom, null);
  assert.equal(first.sub, 'HTML page \u00b7 v1');
  const pending = A.cardModel(A.artifactCall(rawRow({ status: 'in_progress', content: undefined })), [], NOW);
  assert.equal(pending.sub, 'Publishing\u2026');
  assert.equal(pending.canOpen, false);
  const failed = A.cardModel(A.artifactCall(rawRow({ status: 'failed', content: undefined })), [], NOW);
  assert.equal(failed.canOpen, false);
});
test("a card for an older call keeps that call's version, and live data supplies the title", () => {
  const m = A.cardModel(A.artifactCall(rawRow()), [art({ version: 5, title: 'Renamed' })], NOW);
  assert.equal(m.version, 2);
  assert.equal(m.title, 'Renamed');
  assert.equal(m.sub, 'HTML page \u00b7 v2');
  assert.equal(m.diffFrom, 1);
});
test('the artifact card says what it is and where it lives; built from a doc names the page', () => {
  const m = A.cardModel(A.artifactCall(rawRow()), [art({ version: 5 })], NOW);
  assert.equal(A.cardLine(m), 'Artifact \u00b7 HTML page \u00b7 v2 \u00b7 kept with this chat, view only');
  assert.equal(
    A.cardLine(Object.assign({}, m, { builtFrom: 'Release plan \u203a Rollout' })),
    'Artifact \u00b7 HTML page \u00b7 v2 \u00b7 built from Release plan \u203a Rollout',
  );
  const pending = A.cardModel(A.artifactCall(rawRow({ status: 'in_progress', content: undefined })), [], NOW);
  assert.equal(A.cardLine(pending), 'Publishing\u2026');
});
test('files written inside outputs/ get a card once the artifact exists; others get a Preview button', () => {
  const list = [
    art({
      id: 'a1',
      kind: 'csv',
      sourcePath: 'C:\\REPOS\\proj\\outputs\\drop_rates.csv',
      version: 1,
      title: 'drop_rates.csv',
    }),
  ];
  const m = A.outputsCardModel('c:/repos/proj/outputs/drop_rates.csv', list, NOW);
  assert.equal(m.id, 'a1');
  assert.equal(m.badge, 'csv');
  assert.equal(m.sub, 'CSV table \u00b7 v1 \u00b7 updated just now');
  assert.equal(m.diffFrom, null);
  assert.equal(A.outputsCardModel('C:\\REPOS\\proj\\outputs\\other.csv', list, NOW), null);
  for (const f of ['a.html', 'b.HTM', 'c.svg', 'd.md', 'e.png', 'f.jpeg', 'g.pdf', 'h.csv', 'i.json', 'j.txt', 'k.log'])
    assert.equal(A.isPreviewable(f), true, f);
  for (const f of ['a.py', 'b.js', 'c', 'd.exe', 'e.html.bak']) assert.equal(A.isPreviewable(f), false, f);
  assert.equal(A.kindOfPath('x/y.markdown'), 'md');
});
test('writeTarget finds files written or edited by a tool row, never read', () => {
  const write = {
    role: 'tool',
    raw: {
      status: 'completed',
      kind: 'edit',
      _meta: { claudeCode: { toolName: 'Write' } },
      rawInput: { file_path: 'C:\\REPOS\\proj\\outputs\\a.html', content: '<p>x</p>' },
    },
  };
  assert.equal(A.writeTarget(write), 'C:\\REPOS\\proj\\outputs\\a.html');
  const edit = {
    role: 'tool',
    call: { name: 'Edit', input: { file_path: '/w/a.md', old_string: 'a', new_string: 'b' }, result: { text: 'ok' } },
  };
  assert.equal(A.writeTarget(edit), '/w/a.md');
  const read = {
    role: 'tool',
    raw: {
      status: 'completed',
      kind: 'read',
      _meta: { claudeCode: { toolName: 'Read' } },
      rawInput: { file_path: '/w/a.md' },
    },
  };
  assert.equal(A.writeTarget(read), null);
  assert.equal(
    A.writeTarget({
      role: 'tool',
      raw: {
        status: 'failed',
        kind: 'edit',
        _meta: { claudeCode: { toolName: 'Write' } },
        rawInput: { file_path: '/w/a.md', content: 'x' },
      },
    }),
    null,
  );
});

/* ---- live events ---- */
test('pushed artifact events are read from either shape; other events only hint', () => {
  const s = art();
  assert.deepEqual(A.artifactEvent({ type: 'artifact', conversationId: 'c1', artifact: s }), {
    conversationId: 'c1',
    summary: s,
  });
  assert.deepEqual(A.artifactEvent({ kind: 'artifact', data: { conversationId: 'c2', artifact: s } }), {
    conversationId: 'c2',
    summary: s,
  });
  assert.equal(A.artifactEvent({ type: 'artifact', artifact: {} }), null);
  assert.equal(A.artifactEvent({ kind: 'user' }), null);
  assert.equal(A.eventHintsArtifact({ kind: 'turn_end', data: {} }), true);
  assert.equal(
    A.eventHintsArtifact({
      kind: 'update',
      data: { update: { sessionUpdate: 'tool_call_update', status: 'completed', kind: 'edit' } },
    }),
    true,
  );
  assert.equal(
    A.eventHintsArtifact({
      kind: 'update',
      data: { update: { sessionUpdate: 'tool_call_update', status: 'in_progress', kind: 'edit' } },
    }),
    false,
  );
  assert.equal(
    A.eventHintsArtifact({
      kind: 'update',
      data: {
        update: {
          sessionUpdate: 'tool_call_update',
          status: 'completed',
          _meta: { claudeCode: { toolName: 'mcp__studio_artifact__update' } },
        },
      },
    }),
    true,
  );
  assert.equal(
    A.eventHintsArtifact({ kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk' } } }),
    false,
  );
  assert.equal(A.eventHintsArtifact(null), false);
});

/* ---- compare view ---- */
test('a unified diff parses into hunks per file, with counts', () => {
  const diff = [
    'diff --git a/p.html b/p.html',
    '--- a/p.html',
    '+++ b/p.html',
    '@@ -1,3 +1,3 @@',
    ' <h1>',
    '-old',
    '+new',
    ' </h1>',
    '\\ No newline at end of file',
    '@@ -10 +10,2 @@',
    ' a',
    '+b',
  ].join('\n');
  const f = A.parseUnifiedDiff(diff);
  assert.equal(f.length, 1);
  assert.equal(f[0].name, 'p.html');
  assert.equal(f[0].hunks.length, 2);
  assert.deepEqual(f[0].hunks[0].lines, [' <h1>', '-old', '+new', ' </h1>', '\\ No newline at end of file']);
  assert.deepEqual(A.diffStats(f), { added: 2, removed: 1 });
  // The Changes tab's row builder numbers these hunks.
  assert.deepEqual(
    C.hunkRows(f[0].hunks[0])
      .map((r) => [r.type, r.old, r.new])
      .slice(0, 3),
    [
      ['ctx', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
    ],
  );
});
test('plain unified text without file headers, and an empty diff, are handled', () => {
  assert.equal(A.parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n')[0].hunks[0].lines.length, 2);
  assert.deepEqual(A.parseUnifiedDiff(''), []);
  assert.deepEqual(A.parseUnifiedDiff(null), []);
  assert.equal(
    A.parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d').length,
    2,
  );
});

/* ---- tab row (changes-ui.js) ---- */
test('the right column has an Artifacts tab that can be widened like Changes', () => {
  assert.deepEqual(C.TABS, ['activity', 'changes', 'artifacts']);
  let s = C.tabState(null, { type: 'show', tab: 'artifacts' });
  assert.equal(s.tab, 'artifacts');
  s = C.tabState(s, { type: 'toggleExpand' });
  assert.equal(s.expanded, true);
  s = C.tabState(s, { type: 'show', tab: 'changes' });
  assert.equal(s.expanded, true, 'widening carries between the two wide tabs');
  assert.deepEqual(C.tabState(s, { type: 'show', tab: 'activity' }), { tab: 'activity', expanded: false });
  assert.deepEqual(C.tabState({ tab: 'artifacts', expanded: true }, { type: 'subchat', open: true }), {
    tab: 'activity',
    expanded: false,
  });
});
test('chat.html loads the module (deferred, before chat.js) and the stylesheet', () => {
  const { scripts, styles, html } = pageAssets();
  assert.ok(scripts.includes('/artifacts-ui.js'));
  assert.ok(styles.includes('/artifacts.css'));
  assert.match(html, /<script\b[^>]*\bsrc=["']\/artifacts-ui\.js["'][^>]*\bdefer\b/);
  assert.ok(
    scripts.indexOf('/artifacts-ui.js') < scripts.indexOf('/chat.js'),
    'chat.js hands the page to the modules, so they load first',
  );
});

test('reply file paths: viewable files inside the project become preview links; URLs and outside paths do not', () => {
  const P = String.raw`C:\Users\me\proj`,
    files = (t) =>
      A.fileSegments(t, P)
        .filter((s) => s.t === 'file')
        .map((s) => [s.v, s.path]);
  assert.deepEqual(files(String.raw`I made the page at C:\Users\me\proj\dow.html . Open it`), [
    [String.raw`C:\Users\me\proj\dow.html`, String.raw`C:\Users\me\proj\dow.html`],
  ]);
  assert.deepEqual(files('see outputs/chart.svg'), [
    ['outputs/chart.svg', String.raw`C:\Users\me\proj\outputs\chart.svg`],
  ]);
  assert.deepEqual(files('https://x.com/a/b.html'), []);
  assert.deepEqual(files(String.raw`D:\other\x.html`), []);
  assert.deepEqual(files('mail me@site.md or foo.mdx or app.py'), []);
  assert.deepEqual(A.fileSegments('a.html', ''), [{ t: 'text', v: 'a.html' }]);
});

test('reply file paths: a Markdown link to a file becomes one link with its label, not two', () => {
  const P = String.raw`C:\Users\me\proj`;
  const segs = A.fileSegments('Research is in [notes.md](outputs/docs/notes.md). The short version:', P);
  assert.deepEqual(segs, [
    { t: 'text', v: 'Research is in ' },
    { t: 'file', v: 'notes.md', path: String.raw`C:\Users\me\proj\outputs\docs\notes.md` },
    { t: 'text', v: '. The short version:' },
  ]);
  assert.deepEqual(
    A.fileSegments('[a.html](a.html:12) and b.svg', P).map((s) => s.t + ':' + s.v),
    ['file:a.html', 'text: and ', 'file:b.svg'],
  );
  /* Links to web pages or outside the project are left alone. */
  assert.deepEqual(
    A.fileSegments('[x](https://x.com/a.md)', P).filter((s) => s.t === 'file'),
    [],
  );
  assert.deepEqual(
    A.fileSegments(String.raw`[x](D:\other\a.md)`, P).filter((s) => s.t === 'file'),
    [],
  );
});

/* ---- archive and Recently deleted (owner decisions 2026-11-12) ---- */
const DAY = 86400;
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime() / 1000; // local time, like the page
test('archived, deleted and live: one state per artifact; only live ones count', () => {
  const live = art({ id: 'l' }),
    arch = art({ id: 'a', archivedAt: 100 }),
    del = art({ id: 'd', deletedAt: 200, archivedAt: 100 }),
    hist = { id: 'h', title: 'doc rev', versions: 1 };
  assert.deepEqual([live, arch, del].map(A.artState), ['live', 'archived', 'deleted']);
  assert.equal(A.artState(null), 'gone');
  assert.equal(A.isArchived(del), false, 'a deleted artifact reads deleted, not archived');
  assert.equal(A.isLive(hist), false, 'a doc history is never a live artifact');
  assert.deepEqual(A.liveOf([live, arch, del, hist]).map((a) => a.id), ['l']);
  assert.deepEqual(['live', 'archived', 'deleted', 'gone'].map(A.stateWord), ['', 'archived', 'deleted', 'deleted']);
});
test('the picker: live artifacts in Pinned / This chat, then "Archived N" and "Recently deleted N" closed at the foot', () => {
  const list = [
    art({ id: 'p', title: 'Pinned', pinned: true }),
    art({ id: 'l', title: 'Live' }),
    art({ id: 'a1', title: 'Old draft', archivedAt: 1794175000 - 2 * DAY }),
    art({ id: 'a2', title: 'Older draft', archivedAt: 1794175000 - 3 * DAY }),
    art({ id: 'd1', title: 'Duplicate', deletedAt: 1794175000 - 60, purgeAt: 1794175000 - 60 + 30 * DAY }),
  ];
  let g = A.pickerGroups(list, 'l', NOW);
  assert.deepEqual(
    g.map((x) => [x.key, x.label, x.count === undefined ? x.items.length : x.count, x.items.length]),
    [
      ['pinned', 'Pinned', 1, 1],
      ['chat', 'This chat', 1, 1],
      ['archived', 'Archived', 2, 0],
      ['deleted', 'Recently deleted', 1, 0],
    ],
  );
  assert.equal(g[2].divider, true, 'one divider above the foot groups');
  assert.equal(g[3].divider, false);
  g = A.pickerGroups(list, 'a1', NOW, [], [], '', { archived: true, deleted: true });
  const archived = g.find((x) => x.key === 'archived'),
    deleted = g.find((x) => x.key === 'deleted');
  assert.deepEqual(archived.items.map((r) => r.id), ['a1', 'a2'], 'newest archived first');
  assert.equal(archived.items[0].meta, 'Archived 2 d ago');
  assert.equal(archived.items[0].on, true);
  assert.equal(archived.items[0].archived, true);
  assert.equal(deleted.items[0].deleted, true);
  assert.match(deleted.items[0].line, /^Deleted \d+ \w{3}, \d\d:\d\d\. Removed for good on \d+ \w{3}\.$/);
  // nothing live: only the foot groups (no divider above them)
  g = A.pickerGroups([list[2]], '', NOW);
  assert.deepEqual(g.map((x) => [x.key, x.divider]), [['archived', false]]);
  // a group you opened stays while empty and says so in the chat menu's words
  g = A.pickerGroups([list[1]], 'l', NOW, [], [], '', { archived: true, deleted: true });
  assert.deepEqual(
    g.filter((x) => x.foot).map((x) => [x.label, x.count, x.empty]),
    [
      ['Archived', 0, 'Nothing archived.'],
      ['Recently deleted', 0, 'Nothing deleted recently.'],
    ],
  );
  assert.deepEqual(A.pickerGroups([list[1]], 'l', NOW).map((x) => x.key), ['chat'], 'closed and empty: not shown');
});
test('the picker is a dropdown as soon as something is archived or deleted, even with one live artifact or none', () => {
  assert.equal(A.pickerIsPlain([art()]), true);
  assert.equal(A.pickerIsPlain([art(), art({ id: 'z', archivedAt: 5 })]), false);
  assert.equal(A.pickerIsPlain([art({ id: 'z', deletedAt: 5 })]), false);
  assert.deepEqual(A.hiddenCounts([art(), art({ id: 'z', archivedAt: 5 }), art({ id: 'y', deletedAt: 6 })]), { archived: 1, deleted: 1 });
  assert.equal(A.hiddenCounts([art()]), null);
});
test('the viewer menu ends with Archive and Delete (red); archived reads Unarchive and offers no Pin; deleted only Restore', () => {
  const items = A.menuItems({ kind: 'md', shown: 1, latest: 1 });
  assert.deepEqual(ids(items).slice(-3), ['|', 'archive', 'delete']);
  assert.equal(items.find((i) => i.id === 'delete').danger, true);
  assert.equal(items.find((i) => i.id === 'archive').label, 'Archive');
  const arch = A.menuItems({ kind: 'md', shown: 1, latest: 1, archived: true, pinned: true });
  assert.deepEqual(ids(arch).slice(-2), ['unarchive', 'delete']);
  assert.equal(arch.find((i) => i.id === 'unarchive').label, 'Unarchive');
  assert.ok(!ids(arch).includes('pin'));
  assert.deepEqual(A.menuItems({ kind: 'md', shown: 1, latest: 1, deleted: true }), [{ id: 'undelete', label: 'Restore' }]);
  // a copy AIB kept because the chat's folder is gone: Copy path offers it
  assert.ok(ids(A.menuItems({ kind: 'md', shown: 1, latest: 1, sourceCopy: 'C:\\s\\a.md' })).includes('copycopy'));
});
test("a row's ⋯ menu: Open, Pin, then Archive and Delete; archived rows Unarchive; a now-a-doc row says what Delete takes", () => {
  const rm = (a) => A.rowMenuItems(a).map((i) => (i.sep ? '|' : i.hint ? 'hint' : i.id));
  assert.deepEqual(rm(art()), ['open', 'pin', '|', 'archive', 'delete']);
  assert.equal(A.rowMenuItems(art({ pinned: true }))[1].label, 'Unpin');
  assert.deepEqual(rm(art({ archivedAt: 5 })), ['open', '|', 'unarchive', 'delete']);
  assert.deepEqual(rm(art({ becameDoc: 'checklist' })), ['open', 'pin', '|', 'archive', 'delete', 'hint']);
  assert.match(A.rowMenuItems(art({ becameDoc: 'x' })).pop().hint, /^The doc stays\./);
  assert.deepEqual(A.rowMenuItems(art({ deletedAt: 5 })), [], 'deleted rows have Restore and Delete now instead');
  assert.equal(A.rowMenuItems(art()).find((i) => i.id === 'delete').danger, true);
});
test('dates read "12 Nov, 14:02" and "12 Dec"; another year is named', () => {
  const now = at(2026, 10, 12, 15, 0) * 1000;
  assert.equal(A.whenText(at(2026, 10, 12, 14, 2), now), '12 Nov, 14:02');
  assert.equal(A.dayText(at(2026, 11, 12), now), '12 Dec');
  assert.equal(A.dayText(at(2027, 0, 3), now), '3 Jan 2027');
  assert.equal(A.dayText(0, now), '');
});
test('a Recently deleted row says when, when it goes for good, and which file went or why it stayed', () => {
  const now = at(2026, 10, 12, 15, 0) * 1000;
  const d = (o) => art(Object.assign({ deletedAt: at(2026, 10, 12, 14, 2), purgeAt: at(2026, 11, 12, 14, 2) }, o));
  assert.equal(A.deletedLine(d({}), now), 'Deleted 12 Nov, 14:02. Removed for good on 12 Dec.');
  assert.equal(
    A.deletedLine(d({ deletedFile: { path: 'outputs/report.html' } }), now),
    'Deleted 12 Nov, 14:02. Removed for good on 12 Dec. outputs/report.html went too; Restore puts it back.',
  );
  assert.equal(
    A.deletedLine(d({ deletedFile: { path: 'README.md', kept: 'another artifact shows it', code: 'shared' } }), now),
    'Deleted 12 Nov, 14:02. Removed for good on 12 Dec. Kept README.md: another artifact uses it.',
  );
  assert.equal(
    A.fileSentence({ path: 'outputs/x.html', kept: 'it was already gone from disk', code: 'gone' }),
    'outputs/x.html was already gone from disk.',
  );
  assert.equal(A.fileSentence({ path: 'a.md', kept: 'Some new server reason.', code: 'brand_new' }), 'Kept a.md: Some new server reason.');
  for (const code of ['folder_unknown', 'link', 'not_file', 'outside', 'git', 'docs', 'shared'])
    assert.match(A.fileSentence({ path: 'x', kept: 'r', code }), /^Kept x: [a-zA-Z]/, code);
  assert.equal(A.deletedLine(art(), now), '', 'not deleted: no line');
  assert.equal(A.deletedStage(d({ title: 'Load test summary' }), now), '"Load test summary" is in Recently deleted until 12 Dec.');
});
test('the note line names what happened: unpinned and archived, the file that went or stayed, a restored copy', () => {
  assert.equal(A.archiveNote('Keeper flow', true, false), 'Archived "Keeper flow".');
  assert.equal(A.archiveNote('Keeper flow', true, true), 'Unpinned and archived "Keeper flow".');
  assert.equal(A.archiveNote('Keeper flow', false), 'Unarchived "Keeper flow".');
  assert.equal(
    A.deleteNote('Report', { path: 'outputs/report.html', action: 'moved' }),
    'Deleted "Report". outputs/report.html went too. In Recently deleted for 30 days.',
  );
  assert.equal(
    A.deleteNote('Notes', { path: 'notes.md', action: 'kept', code: 'outside', reason: 'x' }),
    "Deleted \"Notes\". Kept notes.md: it is outside this chat's folder. In Recently deleted for 30 days.",
  );
  assert.equal(A.deleteNote('Typed', null), 'Deleted "Typed". In Recently deleted for 30 days.');
  assert.equal(A.restoreNote('Report', { path: 'outputs/report.html', action: 'restored' }), 'Restored "Report". outputs/report.html is back.');
  assert.equal(
    A.restoreNote('Report', { path: 'outputs/report.html', action: 'restored_as', as: 'outputs/report (restored).html' }),
    'Restored "Report". A new file sits at outputs/report.html, so the old one is back as outputs/report (restored).html.',
  );
  assert.equal(
    A.restoreNote('Report', { path: 'outputs/report.html', action: 'kept', code: 'folder_gone', reason: 'r' }),
    "Restored \"Report\" without its file: this chat's folder is gone.",
  );
  assert.equal(A.restoreNote('Typed', null), 'Restored "Typed".');
  assert.equal(A.archivedStrip(art({ archivedAt: 1794175000 - 2 * DAY }), NOW), "Archived 2 d ago. Hidden from this chat's list.");
});
test('tool cards keep showing archived and deleted artifacts with the state word; a file card prefers the non-deleted artifact', () => {
  const m = A.cardModel(A.artifactCall(rawRow()), [art({ version: 2, archivedAt: 5 })], NOW);
  assert.equal(m.state, 'archived');
  assert.equal(A.cardModel(A.artifactCall(rawRow()), [art({ version: 2 })], NOW).state, '');
  const src = 'C:\\p\\outputs\\r.html';
  const list = [art({ id: 'old', sourcePath: src, deletedAt: 9 }), art({ id: 'new', sourcePath: src })];
  assert.equal(A.outputsCardModel(src, list, NOW).id, 'new');
  assert.equal(A.outputsCardModel(src, [list[0]], NOW).state, 'deleted');
});

/* ---- archive and Recently deleted: the panel itself, on the fake DOM ---- */
function panel(answers) {
  const { page: fakePage, load } = require('./fake_dom.js');
  const shell = fakePage({ ids: ['artifactsView'] });
  const w = shell.window;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  const calls = [];
  let UI = null;
  w.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const hit = Object.keys(answers).find((k) => url.startsWith(k));
    // the list answers what the page already has (as the server would), unless a test says otherwise
    const reply = hit ? answers[hit] : url.startsWith('/api/live/artifacts?') ? () => ({ artifacts: JSON.parse(JSON.stringify(UI.state().list)) }) : { token: 't' };
    const data = typeof reply === 'function' ? reply(url, body) : reply;
    return { ok: !data.status, status: data.status || 200, json: async () => data };
  };
  const ctx = load(shell, ['artifacts-ui.js']);
  UI = ctx.ArtifactsUI;
  const badge = shell.document.createElement('span'),
    tab = shell.document.createElement('button');
  UI.mount({ view: shell.byId.artifactsView, badge, tab, win: ctx, reveal() {} });
  const view = shell.byId.artifactsView;
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  return { shell, UI, calls, view, badge, flush, w, ctx };
}
const sum = (o) => Object.assign({ conversationId: 'c1', title: 'T', kind: 'html', version: 1, versions: 1, updatedAt: 1794175000, url: 'http://a/x/v1/' }, o);

test('panel: a summary without archivedAt clears it (replayed Archive then Unarchive ends live); counts and picks skip hidden ones', async () => {
  const p = panel({ '/api/live/artifacts?': { artifacts: [] } });
  p.UI.sync({ id: 'c1', busy: false, cwd: '' });
  p.UI.setVisible(true);
  p.UI.upsert(sum({ id: 'a', title: 'A', updatedAt: 2 }));
  p.UI.upsert(sum({ id: 'b', title: 'B', updatedAt: 1 }));
  assert.equal(p.badge.textContent, '2');
  p.UI.upsert(sum({ id: 'a', title: 'A', updatedAt: 2, archivedAt: 5 }));
  assert.equal(p.badge.textContent, '1', 'an archived artifact is not counted');
  p.UI.upsert(sum({ id: 'a', title: 'A', updatedAt: 2 }));
  const a = p.UI.state().list.find((x) => x.id === 'a');
  assert.equal('archivedAt' in a, false, 'Unarchive cleared the flag');
  assert.equal(p.badge.textContent, '2');
  // purged ("Delete now" or the 30 days): the row goes
  p.UI.upsert(sum({ id: 'b', deletedAt: 9, purgeAt: 99 }));
  assert.equal(p.badge.textContent, '1');
  p.UI.onEvents([{ type: 'artifact', conversationId: 'c1', artifact: { id: 'b', conversationId: 'c1', purged: true } }], 'c1');
  assert.equal(p.UI.state().list.map((x) => x.id).join(','), 'a');
});

test('panel: link labels come from what the page knows, the rest in ONE states request; events relabel them', async () => {
  const p = panel({
    '/api/live/artifacts/states': (url) => {
      const ids = decodeURIComponent(url.split('ids=')[1]).split(',');
      return { states: Object.fromEntries(ids.map((id) => [id, id === 'cccccccc' ? 'deleted' : 'gone'])) };
    },
  });
  p.UI.sync({ id: 'c1', busy: false, cwd: '' });
  p.UI.upsert(sum({ id: 'aaaaaaaa', title: 'Live' }));
  p.UI.upsert(sum({ id: 'bbbbbbbb', title: 'Old', archivedAt: 5 }));
  const box = p.shell.document.createElement('div');
  for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'cccccccc']) {
    const l = p.shell.document.createElement('a');
    l.className = 'artifact-link';
    l.dataset.artifactId = id;
    l.textContent = '⧉ ' + id;
    box.append(l);
  }
  p.shell.byId.messages.append(box);
  p.UI.linkify(box);
  p.w.runTimers();
  await p.flush();
  const asks = p.calls.filter((c) => c.url.startsWith('/api/live/artifacts/states'));
  assert.equal(asks.length, 1, 'one request');
  assert.match(decodeURIComponent(asks[0].url), /ids=cccccccc,dddddddd$/, 'only the unknown ids, once each');
  const label = (l) => (l.querySelector('.artifact-state') || { textContent: '' }).textContent;
  assert.deepEqual(box.children.map(label), ['', ' · archived', ' · deleted', ' · deleted', ' · deleted']);
  // drawn again (a scrolled-back window): no new request
  p.UI.linkify(box);
  p.w.runTimers();
  await p.flush();
  assert.equal(p.calls.filter((c) => c.url.startsWith('/api/live/artifacts/states')).length, 1);
  // an event archives the live one: its link says so at once
  p.UI.upsert(sum({ id: 'aaaaaaaa', title: 'Live', archivedAt: 7 }));
  assert.equal(label(box.children[0]), ' · archived');
});

test('panel: Archive from the viewer menu moves to the next live artifact; Undo in the note line brings it back', async () => {
  const p = panel({
    '/api/live/artifacts/item': { versions: [{ n: 1 }] },
    '/api/live/artifacts/archive': (url, body) => ({
      artifacts: [sum({ id: body.ids[0], title: 'First', updatedAt: 3, pinned: false, ...(body.archived ? { archivedAt: 50 } : {}) })],
      refused: [],
      unpinned: body.archived ? [body.ids[0]] : [],
    }),
    '/api/live/artifacts/pin': (url, body) => sum({ id: body.id, title: 'First', updatedAt: 3, pinned: body.pinned }),
  });
  p.UI.sync({ id: 'c1', busy: false, cwd: '' });
  p.UI.setVisible(true);
  p.UI.upsert(sum({ id: 'f', title: 'First', updatedAt: 3, pinned: true }));
  p.UI.upsert(sum({ id: 's', title: 'Second', updatedAt: 2 }));
  assert.equal(p.UI.state().selId, 'f');
  const more = p.view.querySelectorAll('button.ar-ico').find((b) => b.textContent === '⋯');
  more.click();
  const item = p.view.querySelectorAll('.ar-it').find((b) => b.dataset.id === 'archive');
  assert.ok(item, 'Archive in the More menu');
  item.click();
  await p.flush();
  const arch = p.calls.find((c) => c.url === '/api/live/artifacts/archive');
  assert.deepEqual(arch.body, { conversationId: 'c1', ids: ['f'], archived: true });
  assert.equal(p.UI.state().selId, 's', 'the viewer moved on');
  const note = p.view.querySelector('.ar-note');
  assert.equal(note.hidden, false);
  assert.equal(note.querySelector('.ar-note-t').textContent, 'Unpinned and archived "First".');
  const undo = note.querySelector('.ar-note-undo');
  assert.equal(undo.hidden, false);
  undo.onclick();
  await p.flush();
  const last = p.calls.filter((c) => c.url === '/api/live/artifacts/archive').pop();
  assert.equal(last.body.archived, false);
  assert.ok(p.calls.some((c) => c.url === '/api/live/artifacts/pin' && c.body.pinned === true), 'pinned again');
  assert.equal(p.UI.state().selId, 'f', 'back on it');
});

test('panel: Delete shows which file went and offers Undo; a deleted artifact in the viewer is a message with Restore', async () => {
  const p = panel({
    '/api/live/artifacts/item': { versions: [{ n: 1 }] },
    '/api/live/artifacts/delete': (url, body) => ({
      artifact: sum({ id: body.id, title: 'Report', deletedAt: 1794175000, purgeAt: 1794175000 + 30 * 86400, deletedFile: { path: 'outputs/report.html' } }),
      file: { path: 'outputs/report.html', action: 'moved' },
    }),
    '/api/live/artifacts/undelete': (url, body) => ({ artifact: sum({ id: body.id, title: 'Report' }), file: { path: 'outputs/report.html', action: 'restored' } }),
  });
  p.UI.sync({ id: 'c1', busy: false, cwd: '' });
  p.UI.setVisible(true);
  p.UI.upsert(sum({ id: 'r', title: 'Report' }));
  const more = p.view.querySelectorAll('button.ar-ico').find((b) => b.textContent === '⋯');
  more.click();
  const del = p.view.querySelectorAll('.ar-it').find((b) => b.dataset.id === 'delete');
  assert.ok(del.classList.contains('ar-danger'), 'Delete is red');
  del.click();
  await p.flush();
  assert.equal(p.view.querySelector('.ar-note-t').textContent, 'Deleted "Report". outputs/report.html went too. In Recently deleted for 30 days.');
  assert.equal(p.UI.state().selId, '', 'nothing live left');
  const empty = p.view.querySelector('.ar-empty');
  assert.equal(empty.hidden, false);
  assert.equal(p.view.querySelector('.ar-empty-t').textContent, 'Nothing showing.');
  assert.equal(p.view.querySelector('.ar-empty-hidden').querySelector('button').textContent, 'Recently deleted 1');
  // open it (as a link would): the stage says where it is, with Restore
  await p.UI.open('r');
  const msg = p.view.querySelector('.ar-deleted');
  assert.ok(msg, 'the deleted message');
  assert.match(msg.querySelector('.ar-msg').textContent, /^"Report" is in Recently deleted until \d+ \w{3}\. outputs\/report\.html went too; Restore puts it back\. Restore$/);
  msg.querySelector('.ar-restore').click();
  await p.flush();
  assert.ok(p.calls.some((c) => c.url === '/api/live/artifacts/undelete'));
  assert.equal(p.view.querySelector('.ar-note-t').textContent, 'Restored "Report". outputs/report.html is back.');
  assert.equal(p.UI.state().list[0].deletedAt, undefined);
});

test('panel: the Undo note stays 10 s (5 s without Undo) and is held while the pointer is on it', () => {
  const p = panel({ '/api/live/artifacts?': { artifacts: [] } });
  const timers = new Map();
  let seq = 0;
  p.ctx.setTimeout = (fn, ms) => (timers.set(++seq, { fn, ms }), seq);
  p.ctx.clearTimeout = (id) => timers.delete(id);
  const note = p.view.querySelector('.ar-note');
  p.UI.note('Plain message');
  assert.deepEqual([...timers.values()].map((t) => t.ms), [5000]);
  timers.clear();
  p.UI.note('Archived "X".', () => {});
  assert.deepEqual([...timers.values()].map((t) => t.ms), [10000]);
  note.dispatch('pointerenter');
  assert.equal(timers.size, 0, 'held: no timer while the pointer is on it');
  note.dispatch('pointerleave');
  assert.equal(timers.size, 1, 'the time left runs again');
  const [t] = [...timers.values()];
  assert.ok(t.ms >= 1500 && t.ms <= 10000, String(t.ms));
  t.fn();
  assert.equal(note.hidden, true);
  assert.equal(note.querySelector('.ar-note-undo').hidden, true);
});
