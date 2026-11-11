'use strict';
/* Structural checks on chat.html (ported from test_page_structure.py): tags balance, every served front-end module is actually
   loaded, the one-pane page structure, and the screen-reader structure. A dropped closing tag once turned a <script> tag into
   inert text, which no behaviour test noticed. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { servedAsset } = require('./_served_assets');
const { cssRules, declarationsFor } = require('./css_rules');

const HTML = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'source', 'wbr']);
const SCRIPT_SRC = /<script\b[^>]*\bsrc="\/([a-z0-9-]+\.js)"/g; // reads the tag, not its exact spelling
const LOADED_ON_DEMAND = new Set(['elicitation-ui.js']); // fetched by chat.js only when the server supports questions
const DOC_HTML = fs.readFileSync(path.join(APP, 'doc.html'), 'utf8'); // the doc page loads its own scripts
const scripts = () => [...HTML.matchAll(SCRIPT_SRC)].map((m) => m[1]);

/** Elements of an HTML text in document order as {tag, attrs, parents} (parents: the open elements around it, outermost first). */
function tree(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  const stack = [],
    nodes = [];
  for (const m of text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, closing, rawTag, rest] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (VOID.has(tag)) continue;
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at !== -1) stack.length = at;
      continue;
    }
    const attrs = {};
    for (const a of rest.matchAll(/([^\s=/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g)) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? (a[2] === undefined ? null : a[2]);
    }
    const node = { tag, attrs, parents: [...stack] };
    nodes.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) stack.push(node);
  }
  return nodes;
}
const NODES = tree(HTML);

function element(id) {
  const found = NODES.filter((n) => n.attrs.id === id);
  assert.equal(found.length, 1, id);
  return found[0];
}

test('tags balance', () => {
  const counts = new Map();
  for (const [, closing, name] of HTML.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)/g)) {
    const tag = name.toLowerCase();
    if (!VOID.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + (closing ? -1 : 1));
  }
  assert.deepEqual(Object.fromEntries([...counts].filter(([, v]) => v)), {});
});

test('every script tag is closed', () => {
  const bodies = [...HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(bodies.length);
  for (const body of bodies) assert.ok(!body.includes('<script'), body);
});

test('the content security policy allows local attachment previews', () => {
  // Composer thumbnails use URL.createObjectURL (blob:); without it every pasted picture shows as broken.
  const security = fs.readFileSync(path.join(APP, 'server', 'web', 'security.ts'), 'utf8');
  // The main page's CSP is the one in securityHeaders (drawingHeaders, the drawing page's own, comes first in the file).
  const main = security.slice(security.indexOf('export function securityHeaders('));
  assert.ok(main.length < security.length, 'securityHeaders in server/web/security.ts');
  const csp = main.match(/`default-src[^`]*`/);
  assert.ok(csp, 'the page CSP in server/web/security.ts');
  assert.match(csp[0], /script-src 'self';/, 'the main page CSP, not the drawing page one');
  const imgSrc = csp[0].match(/img-src ([^;]*);/)[1].split(/\s+/);
  assert.ok(imgSrc.includes('blob:'), imgSrc.join(' '));
  assert.ok(!imgSrc.includes('*'), imgSrc.join(' '));
});

test('every served module is loaded', () => {
  // The server serves any plainly named .js/.css in the app folder (studioAsset); every such script except the monitor
  // dashboard's own must be loaded by chat.html, or it is dead code.
  const served = fs.readdirSync(APP).filter((n) => n.endsWith('.js') && servedAsset('/' + n));
  const loaded = new Set([...scripts(), ...[...DOC_HTML.matchAll(SCRIPT_SRC)].map((m) => m[1])]);
  assert.deepEqual(
    served.filter((n) => !loaded.has(n) && !LOADED_ON_DEMAND.has(n)),
    [],
  );
  for (const name of loaded) assert.equal(servedAsset('/' + name), name);
});

test('the asset pattern refuses everything else', () => {
  assert.equal(servedAsset('/'), 'chat.html');
  assert.equal(servedAsset('/chat.css'), 'chat.css');
  for (const p of [
    '/studio.py',
    '/../studio.py',
    '/..%2fstudio.py',
    '/docs/VISION.md',
    '/.hidden.js',
    '/Chat.js',
    '/chat.js.map',
    '/app.js',
    '/style.css',
    '/sidebar.js',
    '/sidebar.css',
    '/missing-file.js',
    '/chat.js?x',
    '//chat.js',
    '/chat.html/x',
    '',
    null,
  ])
    assert.equal(servedAsset(p), null, String(p));
});

test('the one-pane page is the page of today', () => {
  // With one pane nothing is rebuilt: the tab strip, header and chat sit directly in <main>, in this order. Split view moves these
  // nodes into a pane only while two or more panes exist (split-ui.js) and puts them back afterwards.
  const main = NODES.find((n) => n.tag === 'main');
  assert.ok(main);
  const children = NODES.filter((n) => n.parents[n.parents.length - 1] === main).map((n) => [
    n.tag,
    n.attrs.id ?? null,
  ]);
  assert.deepEqual(
    children.filter((c) => c[0] !== 'header'),
    [
      ['div', 'chatTabs'],
      ['div', 'ownershipBar'],
      ['section', 'setup'],
      ['div', 'error'],
      ['div', 'updateBanner'],
      ['div', 'studioNotice'],
      ['div', 'authPrompts'],
      ['div', 'setupQuestions'],
      ['section', 'chat'],
    ],
  );
  assert.equal(children.map((c) => c[0]).indexOf('header'), 1);
  assert.ok(!HTML.includes('splitStage'), 'the stage is built by split-ui.js only when there are panes');
});

test('split scripts and styles are loaded in order', () => {
  const s = scripts();
  for (const name of ['split-tree.js', 'split-ui.js']) assert.ok(s.includes(name), name);
  assert.ok(s.indexOf('workspace-ui.js') < s.indexOf('split-tree.js'));
  assert.ok(s.indexOf('split-tree.js') < s.indexOf('split-ui.js'));
  assert.ok(s.indexOf('split-ui.js') < s.indexOf('chat.js'));
  assert.ok(HTML.includes('<link rel="stylesheet" href="/split.css">'));
  for (const name of ['/split.css', '/split-tree.js', '/split-ui.js']) assert.equal(servedAsset(name), name.slice(1));
});

test('the activity column starts with the open chat header', () => {
  // Decision 2: the Activity column says which chat it shows. First child of the column, empty and hidden until a chat is open.
  const m = HTML.match(/<section id="subagentsPane"[^>]*>(<div[^>]*>)/);
  assert.ok(m);
  assert.ok(m[1].includes('id="activityHead"'));
  assert.ok(m[1].includes('class="ahead"'));
  assert.ok(m[1].includes('hidden'));
});

test('the split hooks and keys have behaviour tests', () => {
  // The hooks chat.js gives split-ui.js, the key bindings and the narrow-window rule are exercised by running the code:
  // work/test_chat_page.js (host hooks, card drag) and work/test_split_keys.js (keys, menu, narrow width).
  const s = scripts();
  for (const name of ['workspace-ui.js', 'split-tree.js', 'split-ui.js', 'chat.js']) assert.ok(s.includes(name), name);
  for (const name of ['test_chat_page.js', 'test_split_keys.js'])
    assert.ok(fs.existsSync(path.join(__dirname, name)), name);
});

test('the message list is not a live region', () => {
  const node = element('messages');
  assert.ok(!('aria-live' in node.attrs));
  assert.ok(!('role' in node.attrs));
  for (const parent of node.parents)
    assert.ok(!('aria-live' in parent.attrs), 'an ancestor of #messages would make it live');
});

test('one visually hidden polite live region sits outside main', () => {
  const node = element('liveAnnounce');
  assert.equal(node.attrs['aria-live'], 'polite');
  assert.ok((node.attrs.class ?? '').split(/\s+/).includes('sr-only'));
  assert.deepEqual(
    node.parents.map((p) => p.tag),
    ['html', 'body'],
    'a direct child of <body>, so every split pane shares it',
  );
  const rule = declarationsFor(cssRules(fs.readFileSync(path.join(APP, 'chat.css'), 'utf8')), '.sr-only');
  assert.ok(Object.keys(rule).length, 'chat.css has no .sr-only rule');
  for (const [name, value] of [
    ['position', 'absolute'],
    ['width', '1px'],
    ['height', '1px'],
    ['overflow', 'hidden'],
  ]) {
    assert.equal(rule[name], value, name);
  }
});

test('the info button has an accessible name', () => {
  const node = element('infoCurrent');
  assert.equal(node.tag, 'button');
  assert.ok((node.attrs['aria-label'] ?? '').trim());
});

test('the page is called AIB: its title, and the chat title suffix (QA 4 #6)', () => {
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const { APP: dirx } = require('./_paths');
  const html = fsx.readFileSync(pathx.join(dirx, 'chat.html'), 'utf8');
  assert.match(html, /<title>AIB<\/title>/);
  assert.doesNotMatch(html, /Agent Studio|End Studio session/);
  const chat = fsx.readFileSync(pathx.join(dirx, 'chat.js'), 'utf8');
  assert.match(chat, /' · AIB'/);
});
