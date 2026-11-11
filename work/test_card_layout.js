'use strict';
/* Layout check in a real browser: every chat card state (normal, hover, keyboard focus, selected, selected + hover, needs-you,
   selected + needs-you, pinned, on hold, working, archived, 2 / 3 / 4 lines) has the same width, its height depends only on
   how many lines it holds, and the title, line 2, line 3 and the age sit at the same place in every card (0.5 px). Same for
   the active and inactive chat tab. The page is chat.html with its own stylesheets and no scripts; the card and tab markup is
   what sidebar-ui.js / organize-ui.js / workspace-ui.js build.
   Runs headless Chrome or Edge (no window). Set CHROME_PATH to choose one; with none installed the tests are skipped. */
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// One card as decorateRow (sidebar-ui.js) and row() (organize-ui.js) build it.
function card(o) {
  const mark =
    o.mark === 'need'
      ? '<span class="status-mark"><span class="status-dot d-need" role="img"></span><span class="status-count" aria-hidden="true">1</span></span>'
      : o.mark === 'work'
        ? '<span class="status-mark"><span class="status-dot d-work" role="img"></span></span>'
        : '<span class="status-mark"></span>';
  const cls = ['connection'].concat(o.cls || []).join(' ');
  const line3 = o.hold
    ? '<small class="hold-note row-line3"><span class="hold-text">waiting on CI</span><span class="hold-age"> · held 5m</span></small>'
    : o.lines >= 3
      ? '<small class="row-line3"><span class="row-preview">Rate limiting is in: `/login` 5 per minute, `/search` 30 per minute.</span></small>'
      : '';
  const branch =
    o.lines >= 4
      ? '<small class="row-line3 row-branch"><span class="row-branch-name">⎇ claude/pensive-ritchie-26be75</span></small>'
      : '';
  return (
    `<div class="conversation-row"><button class="${cls}" data-state="${esc(o.name)}" type="button">` +
    `<small class=" connection-workspace row-meta">${mark}<span class="row-meta-text">Claude Code</span></small>` +
    `<span class="connection-title">Add rate limiting to the API and more</span>` +
    `<small class="connection-state"><span class="badge badge-saved">Saved</span></small>` +
    `<span class="row-age">${esc(o.age || '1d')}</span>` +
    `<span class="row-status tone-${o.tone || 'off'}"><span class="row-phrase">${esc(o.phrase || 'Not running')}</span>` +
    `<span class="row-agent"> · Claude Code</span></span>${line3}${branch}` +
    (o.pin ? '<span class="row-pin" role="img" aria-label="Pinned"></span>' : '') +
    `</button><button class="rename-chat" type="button" aria-label="Actions">⋯</button></div>`
  );
}
const need = { mark: 'need', cls: ['attn-needs_you'], age: 'now', phrase: 'Needs you', tone: 'need' };
const work = { mark: 'work', age: 'now', phrase: 'Working · 3m', tone: 'work' };
const STATES = [
  { name: 'normal', lines: 3 },
  { name: 'normal 2 lines', lines: 2 },
  { name: 'hover', lines: 3, force: ['hover'] },
  { name: 'keyboard focus', lines: 3, force: ['focus', 'focus-visible'] },
  { name: 'selected', lines: 3, cls: ['selected'] },
  { name: 'selected 2 lines', lines: 2, cls: ['selected'] },
  { name: 'selected + hover', lines: 3, cls: ['selected'], force: ['hover'] },
  { ...need, name: 'needs-you', lines: 3 },
  { ...need, name: 'selected + needs-you', lines: 3, cls: ['selected', 'attn-needs_you'] },
  { name: 'pinned', lines: 3, pin: true, cls: ['is-pinned'] },
  { ...work, name: 'working', lines: 3 },
  { ...work, name: 'selected + working 2 lines', lines: 2, cls: ['selected'] },
  { name: 'branch 4 lines', lines: 4 },
  { ...need, name: 'selected + needs-you + branch 4 lines', lines: 4, cls: ['selected', 'attn-needs_you'] },
];
const HOLD = { name: 'on hold', lines: 3, hold: true };
const ARCHIVED = { name: 'archived', lines: 3 };

const TAB = (on) =>
  `<div class="ws-tab${on ? ' on' : ''} needs" data-key="${on ? 'a' : 'b'}"><button class="ws-tab-main" type="button" role="tab">` +
  '<span class="status-mark"><span class="status-dot d-need" role="img"></span></span>' +
  '<span class="ws-tab-title">Live chat: try the fixture agent</span></button>' +
  '<button class="ws-tab-x" type="button" aria-label="Close">×</button></div>';

function pageHtml() {
  let html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  html = html.replace(/href="\/([\w.-]+\.css)"/g, (_, f) => `href="${pathToFileURL(path.join(APP, f)).href}"`);
  const rows = STATES.map(card).join('');
  html = html.replace(
    '<div id="connections"></div>',
    '<div id="connections"><div class="list-group project-group"><div class="project-rows">' +
      rows +
      '<div class="hold-sub"><div class="hold-rows">' +
      card(HOLD) +
      '</div></div></div></div></div>',
  );
  html = html.replace('<div id="archivedList"></div>', `<div id="archivedList">${card(ARCHIVED)}</div>`);
  html = html.replace(
    '<details id="archivedBox" class="archived-box">',
    '<details id="archivedBox" class="archived-box" open>',
  );
  html = html.replace(
    '<div id="chatTabs" class="ws-tabs"></div>',
    `<div id="chatTabs" class="ws-tabs"><div class="ws-tablist" role="tablist">${TAB(true)}${TAB(false)}</div></div>`,
  );
  return html;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-card-layout-'));
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, pageHtml());
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
  await c.send('Page.navigate', { url: pathToFileURL(file).href });
  for (let i = 0; i < 100; i++) {
    const r = await c.send('Runtime.evaluate', {
      expression: "document.readyState === 'complete' && !!document.querySelector('[data-state]')",
      returnByValue: true,
    });
    if (r.result.value) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // :hover and :focus-visible forced the way DevTools does it, on the cards that stand for those states.
  const { root } = await c.send('DOM.getDocument', { depth: -1 });
  for (const s of [...STATES, HOLD, ARCHIVED].filter((x) => x.force)) {
    const { nodeId } = await c.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-state="${s.name}"]` });
    await c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: s.force });
  }
  const evaluate = async (fn) => {
    const r = await c.send('Runtime.evaluate', { expression: `(${fn})()`, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  session = {
    evaluate,
    close() {
      c.close();
      proc.kill();
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }), 500).unref();
    },
  };
  return session;
}

test.after(() => session && session.close());

function measureCards() {
  const rel = (e, b) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x - b.x, y: r.y - b.y, right: r.right - b.x, bottom: r.bottom - b.y };
  };
  return [...document.querySelectorAll('[data-state]')].map((n) => {
    const b = n.getBoundingClientRect();
    const line3 = n.querySelector('.row-line3:not(.row-branch)');
    const pad = line3 ? parseFloat(getComputedStyle(line3).paddingLeft) : 0;
    const l3 = rel(line3, b);
    return {
      name: n.dataset.state,
      x: b.x,
      w: b.width,
      h: b.height,
      clipped: n.scrollHeight > n.clientHeight + 0.5,
      title: rel(n.querySelector('.connection-title'), b),
      line2: rel(n.querySelector('.row-phrase'), b),
      line3: l3 && { x: l3.x + pad, y: l3.y },
      branch: rel(n.querySelector('.row-branch'), b),
      age: rel(n.querySelector('.row-age'), b),
    };
  });
}

const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.5, `${what}: ${a} vs ${b}`);

test(
  'chat cards: same width, height set by the number of lines only, text in the same place in every state',
  { skip: !BROWSER && 'no Chrome or Edge found' },
  async () => {
    const s = await open();
    const cards = await s.evaluate(measureCards);
    assert.equal(cards.length, STATES.length + 2);
    const base = cards.find((c) => c.name === 'normal'),
      base2 = cards.find((c) => c.name === 'normal 2 lines'),
      base4 = cards.find((c) => c.name === 'branch 4 lines');
    const all = [...STATES, HOLD, ARCHIVED];
    for (const c of cards) {
      const lines = all.find((x) => x.name === c.name).lines;
      const ref = lines === 2 ? base2 : lines === 4 ? base4 : base;
      near(c.x, base.x, `${c.name} left edge`);
      near(c.w, base.w, `${c.name} width`);
      near(c.h, ref.h, `${c.name} height`);
      assert.ok(!c.clipped, `${c.name}: nothing is cut off`);
      for (const k of ['title', 'line2']) {
        near(c[k].x, base[k].x, `${c.name} ${k} x`);
        near(c[k].y, base[k].y, `${c.name} ${k} y`);
      }
      near(c.age.right, base.age.right, `${c.name} age right edge`);
      near(c.age.y, base.age.y, `${c.name} age y`);
      if (lines >= 3) {
        near(c.line3.x, base.line3.x, `${c.name} line 3 x`);
        near(c.line3.y, base.line3.y, `${c.name} line 3 y`);
      }
      if (lines === 4)
        assert.ok(c.branch.bottom <= c.h - 6 + 0.5, `${c.name}: the branch line sits inside the padding`);
    }
    // The heights the cards had before: 56 / 68 px.
    near(base2.h, 56, 'two-line card');
    near(base.h, 68, 'three-line card');
  },
);

test(
  'every colour theme, and the status symbols, lay the cards and tabs out exactly like the default',
  { skip: !BROWSER && 'no Chrome or Edge found' },
  async () => {
    const s = await open();
    const ids = require('./theme_tokens.js').themeIds();
    const measure = () =>
      s.evaluate(
        `() => JSON.stringify([(${measureCards})(), [...document.querySelectorAll('.ws-tab')].map((t) => t.getBoundingClientRect().toJSON())])`,
      );
    await s.evaluate(`() => document.documentElement.removeAttribute('data-theme')`);
    const base = await measure();
    for (const id of ids) {
      await s.evaluate(
        `() => { document.documentElement.setAttribute('data-theme', ${JSON.stringify(id)}); return document.body.offsetHeight; }`,
      );
      assert.equal(await measure(), base, `${id}: a card or tab moved or changed size`);
    }
    // Status symbols on (Settings > Appearance, and always in cb-safe): the symbol takes the dot's box, nothing moves.
    await s.evaluate(
      `() => { document.documentElement.setAttribute('data-status-glyphs', 'on'); return document.body.offsetHeight; }`,
    );
    for (const id of ['teal-dark', 'cb-safe', 'hc-light']) {
      await s.evaluate(
        `() => { document.documentElement.setAttribute('data-theme', ${JSON.stringify('ID')}); return 1; }`.replace(
          'ID',
          id,
        ),
      );
      assert.equal(await measure(), base, `${id} with status symbols: a card or tab moved or changed size`);
      const shown = await s.evaluate(
        `() => getComputedStyle(document.querySelector('.status-dot.d-need'), '::after').content`,
      );
      assert.equal(shown, '"▲"', `${id}: the needs-you symbol is drawn`);
    }
    await s.evaluate(
      `() => { document.documentElement.removeAttribute('data-status-glyphs'); document.documentElement.removeAttribute('data-theme'); return 1; }`,
    );
  },
);

test(
  'chat tabs: the active tab has the inactive tab size, and its dot, title and close button stay put',
  { skip: !BROWSER && 'no Chrome or Edge found' },
  async () => {
    const s = await open();
    const tabs = await s.evaluate(() =>
      [...document.querySelectorAll('.ws-tab')].map((t) => {
        const b = t.getBoundingClientRect(),
          y = (sel) => t.querySelector(sel).getBoundingClientRect().y;
        return {
          on: t.classList.contains('on'),
          y: b.y,
          h: b.height,
          w: b.width,
          title: y('.ws-tab-title'),
          x: y('.ws-tab-x'),
          dot: y('.status-dot'),
        };
      }),
    );
    const on = tabs.find((t) => t.on),
      off = tabs.find((t) => !t.on);
    assert.ok(on && off);
    for (const k of ['y', 'h', 'w', 'title', 'x', 'dot']) near(on[k], off[k], `tab ${k}`);
  },
);
