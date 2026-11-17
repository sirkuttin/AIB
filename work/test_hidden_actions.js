'use strict';
/* Hidden actions made visible (owner rule 2026-11-16: "We shouldn't be hiding things"), checked in a real headless browser on
   chat.html with its own stylesheets and no scripts. Every control below is visible at rest (opacity 1, visibility visible,
   a real box, on every ancestor), has a tooltip, and hovering a chat card changes no layout and shows or hides nothing in it.
   The header menu button opening the chat menu is covered by test_conversation_state.js ("header menu offers the same actions").
   Run: node work/test_hidden_actions.js (headless Chrome or Edge; CHROME_PATH chooses one; none installed = skipped). */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function findBrowser() {
  const list = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return list.find((p) => p && fs.existsSync(p)) || null;
}

const CARD = (name, cls) =>
  `<div class="conversation-row"><button class="connection ${cls || ''}" data-state="${name}" type="button">` +
  '<small class=" connection-workspace row-meta"><span class="status-mark"><span class="status-dot d-work" role="img"></span></span><span class="row-meta-text">Claude Code</span></small>' +
  '<span class="connection-title">Add rate limiting to the API and more</span><span class="row-age">12m</span>' +
  '<span class="row-status tone-work"><span class="row-phrase">Working · 3m</span><span class="row-agent"> · Claude Code</span></span>' +
  '<small class="row-line3"><span class="row-preview">Rate limiting is in: /login 5 per minute, /search 30 per minute.</span></small>' +
  '</button><button class="rename-chat" type="button" title="Conversation actions" aria-label="Conversation actions">\u22EF</button></div>';
const TAB = (on, k) =>
  `<div class="ws-tab${on ? ' on' : ''}" data-key="${k}"><button class="ws-tab-main" type="button" role="tab">` +
  '<span class="ws-tab-title">Live chat: try the fixture agent</span></button>' +
  '<button class="ws-tab-x" type="button" title="Close tab (Alt+W)" aria-label="Close">\u00D7</button></div>';
// Markup as sidebar-ui.js, queue-ui.js, artifacts-ui.js, doc-ui.js and chat.js build it.
const EXTRA =
  '<div id="fx">' +
  '<div class="project-head-row"><span class="head">Project</span><button class="project-more" type="button" title="Project options" aria-label="Project options">\u22EF</button></div>' +
  '<ul><li class="q-row"><span class="q-text">queued</span><span class="q-actions">' +
  '<button class="q-btn" title="Edit">\u270E</button><button class="q-btn" title="Send now">\u2191</button><button class="q-btn" title="Remove">\u2715</button></span></li></ul>' +
  '<div class="ar-it"><span class="ar-it-title">Artifact</span><span class="ar-dots" role="button" title="More">\u22EF</span></div>' +
  '<div class="pg"><span class="nm">Page</span><button class="more" title="Page actions">\u22EF</button></div>' +
  '<div class="attachment-card"><span>file.png</span><button class="attachment-remove" type="button" title="Remove file.png" aria-label="Remove file.png">\u00D7</button></div>' +
  '</div>';

function pageHtml(theme) {
  let html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  html = html.replace(/href="\/([\w.-]+\.css)"/g, (_, f) => `href="${pathToFileURL(path.join(APP, f)).href}"`);
  html = html.replace('<div id="connections"></div>', `<div id="connections">${CARD('a', 'selected')}${CARD('b')}</div>`);
  html = html.replace(
    '<div id="chatTabs" class="ws-tabs"></div>',
    `<div id="chatTabs" class="ws-tabs"><div class="ws-tablist" role="tablist">${TAB(true, 'a')}${TAB(false, 'b')}${TAB(false, 'c')}</div></div>`,
  );
  // the app un-hides the header controls once a chat is open
  html = html.replace(/<button id="organizeCurrent"([^>]*) hidden/, '<button id="organizeCurrent"$1');
  html = html.replace('<span id="vendorChip" class="vend" hidden>', '<span id="vendorChip" class="vend">');
  html = html.replace('<html ', `<html data-theme="${theme}" `);
  return html.replace('</body>', EXTRA + '</body>');
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}

const BROWSER = findBrowser();
let session = null;

async function open() {
  if (session) return session;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-hidden-actions-'));
  const proc = spawn(
    BROWSER,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const portFile = path.join(dir, 'profile', 'DevToolsActivePort');
  const until = Date.now() + 20000;
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n')) {
    if (Date.now() > until) throw new Error('the browser did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  let page;
  while (!page) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.enable');
  await c.send('DOM.enable');
  await c.send('CSS.enable');
  const evaluate = async (expression) => {
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const load = async (theme) => {
    const file = path.join(dir, `page-${theme}.html`);
    fs.writeFileSync(file, pageHtml(theme));
    await c.send('Page.navigate', { url: pathToFileURL(file).href });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.readyState === 'complete' && !!document.querySelector('[data-state]')")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  session = {
    c,
    evaluate,
    load,
    async close() {
      c.close();
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000).unref())]);
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch { /* still locked: left in the OS temp folder */ }
    },
  };
  return session;
}

test.after(() => session && session.close());

const SELS = [
  '.conversation-row .rename-chat',
  '.ws-tab-x',
  '#organizeCurrent',
  '.project-more',
  '.q-btn',
  '.ar-dots',
  '.pg .more',
  '.attachment-remove',
];
// Runs in the page: a box, opacity not below 0.5, visible, on the control and on every ancestor.
const SEEN = `(${(sels) =>
  sels.map((sel) => {
    const nodes = [...document.querySelectorAll(sel)];
    return {
      sel,
      n: nodes.length,
      bad: nodes.filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return true;
        for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (+s.opacity < 0.5 || s.visibility !== 'visible' || s.display === 'none') return true;
        }
        return false;
      }).length,
      untitled: nodes.filter((e) => !(e.title || e.getAttribute('aria-label'))).length,
    };
  })})(${JSON.stringify(SELS)})`;

for (const theme of ['teal-dark', 'teal-light']) {
  test(
    `every formerly hover-only control is visible at rest and has a tooltip (${theme})`,
    { skip: !BROWSER && 'no Chrome or Edge found' },
    async () => {
      const s = await open();
      await s.load(theme);
      const r = await s.evaluate(SEEN);
      for (const x of r) {
        assert.ok(x.n > 0, `${x.sel}: present`);
        assert.equal(x.bad, 0, `${x.sel}: visible at rest`);
        assert.equal(x.untitled, 0, `${x.sel}: has a tooltip`);
      }
      assert.equal(r.find((x) => x.sel === '.ws-tab-x').n, 3, 'every tab has its x');
    },
  );
}

test('hovering a chat card changes no layout and shows or hides nothing', { skip: !BROWSER && 'no Chrome or Edge found' }, async () => {
  const s = await open();
  await s.load('teal-dark');
  const snap = `(() =>
    [...document.querySelectorAll('.conversation-row, .conversation-row *')].filter((e) => !e.matches('.status-dot')).map((e) => {
      const r = e.getBoundingClientRect(), st = getComputedStyle(e);
      return [e.className, r.x, r.y, r.width, r.height, st.opacity, st.visibility, st.display].join('|');
    }))()`;
  const before = await s.evaluate(snap);
  const { root } = await s.c.send('DOM.getDocument', { depth: -1 });
  const rows = await s.c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.conversation-row, .conversation-row .connection' });
  for (const nodeId of rows.nodeIds) await s.c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  const after = await s.evaluate(snap);
  assert.ok(before.length > 8);
  // only the hover fill may differ, and that is a colour, which the snapshot does not record
  assert.deepEqual(after, before);
  const age = await s.evaluate(`[...document.querySelectorAll('.row-age')].map((e) => getComputedStyle(e).visibility)`);
  assert.deepEqual(age, ['visible', 'visible'], 'the age stays');
});

test('the card menu button sits on line 2 under the age and covers no text; the header button is 24 x 24 after the status chip', { skip: !BROWSER && 'no Chrome or Edge found' }, async () => {
  const s = await open();
  await s.load('teal-dark');
  const r = await s.evaluate(`(() => {
    const box = (b) => ({ x: b.x, y: b.y, r: b.right, b: b.bottom, w: b.width, h: b.height });
    const row = document.querySelector('.conversation-row');
    const dots = box(row.querySelector('.rename-chat').getBoundingClientRect());
    const age = box(row.querySelector('.row-age').getBoundingClientRect());
    const hits = ['.row-age', '.row-phrase', '.row-agent', '.connection-title', '.row-preview'].filter((q) => {
      const range = document.createRange();
      range.selectNodeContents(row.querySelector(q));
      const t = range.getBoundingClientRect();
      return t.width && t.x < dots.r && t.right > dots.x && t.y < dots.b && t.bottom > dots.y;
    });
    const g = (id) => box(document.getElementById(id).getBoundingClientRect());
    return { l3: box(row.querySelector('.row-preview').getBoundingClientRect()), dots, age, hits, hd: g('organizeCurrent'), status: g('status') };
  })()`);
  assert.ok(r.dots.y >= r.age.b - 0.5, 'the card menu button is under the age');
  assert.deepEqual(r.hits, [], JSON.stringify(r) + ' no card text sits under the card menu button');
  assert.equal(r.hd.w, 24);
  assert.equal(r.hd.h, 24);
  assert.ok(r.hd.x >= r.status.r - 0.5, 'the header button comes after the status chip');
});
