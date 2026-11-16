/**
 * Chats work in the project folder, the page part (build plan 1b, sections 1.2-1.4; e2e 20-24; architect MF 9 and SF 8).
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), scripted live chats, headless Chrome or
 * Edge. The server parts that another phase builds (GET /api/live/branch's copyable / whyNot, the Changes replies) are answered
 * in the page by a fetch stub installed before the page's own scripts run; connect requests are recorded and passed on.
 *
 * 20. The chip row shows "Works in: Project folder"; the menu rows and their second lines; the folder line follows the choice;
 *     the choice goes out as connect's ownCopy.
 * 21. With a busy folder chat in the project the screen opens on Own copy with the reason, and does not flip when that chat goes
 *     idle while the screen is open.
 * 22. Picking Project folder then shows the amber note, with no dialog.
 * 23. The chip's slot is there before /branch answers (greyed, "Checking…"); a non-git folder keeps it greyed with whyNot; the
 *     row does not reflow when the answer comes.
 * 24. A folder chat's Changes tab: the fixed header, no Merge or Discard, the footer line. An own-copy chat is unchanged.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/works_in_e2e_test.ts   (ignored without Chrome or Edge)
 * AIB_WORKS_IN_SHOTS=<folder> saves a screenshot of each state there.
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, type Page, settle } from './_scroll_lab.ts';

const SHOTS = Deno.env.get('AIB_WORKS_IN_SHOTS') || '';

/** The stub: /api/live/branch answers from localStorage 'test-branch' ({cwdLower: reply}); a cwd with no entry is held until one
 *  appears. /api/live/changes and /api/live/worktree answer from window.__changes (by chat id). Connect bodies go to __connects. */
const STUB = `(() => {
  const real = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.__connects = [];
  window.__branchAsked = [];
  window.fetch = (url, init) => {
    const u = new URL(String(url), location.href);
    if (u.pathname === '/api/live/branch') {
      const cwd = (u.searchParams.get('cwd') || '').toLowerCase();
      window.__branchAsked.push(cwd);
      return new Promise((resolve) => {
        const go = () => {
          let map = {};
          try { map = JSON.parse(localStorage.getItem('test-branch') || '{}'); } catch {}
          if (map[cwd]) resolve(json(map[cwd]));
          else setTimeout(go, 50);
        };
        go();
      });
    }
    // the chat list is held while localStorage 'test-hold-list' is set (the pre-set must wait for it)
    if (u.pathname === '/api/live/list' && localStorage.getItem('test-hold-list'))
      return new Promise((resolve) => {
        const go = () => (localStorage.getItem('test-hold-list') ? setTimeout(go, 50) : resolve(real(url, init)));
        go();
      });
    const id = u.searchParams.get('id') || '';
    const ch = window.__changes && window.__changes[id];
    if (u.pathname === '/api/live/changes' && ch) return Promise.resolve(json(ch));
    if (u.pathname === '/api/live/worktree' && ch)
      return Promise.resolve(json(ch.worktree ? { worktree: true, enabled: true, state: 'ready', base: 'main', label: 'Merge' } : { worktree: false }));
    if (u.pathname === '/api/live/connect' && init && init.body) window.__connects.push(JSON.parse(init.body));
    return real(url, init);
  };
  // every state the Works in chip shows, in order: [greyed, value]
  window.__chipLog = [];
  setInterval(() => {
    const b = document.getElementById('chip-worksin');
    if (!b) return;
    const s = [b.classList.contains('chip-locked'), (b.querySelector('.chip-v') || {}).textContent || ''];
    const last = window.__chipLog[window.__chipLog.length - 1];
    if (!last || last[0] !== s[0] || last[1] !== s[1]) window.__chipLog.push(s);
  }, 20);
})()`;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const r = await page.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
  Deno.mkdirSync(SHOTS, { recursive: true });
  Deno.writeFileSync(`${SHOTS}\\${name}.png`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
}

async function openLab(branch: Record<string, unknown>): Promise<Lab> {
  const lab = await Lab.open(1600, 900);
  await lab.page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await lab.page.eval(`localStorage.setItem('test-branch', ${JSON.stringify(JSON.stringify(branch))})`);
  await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await lab.page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  return lab;
}
const key = (lab: Lab) => lab.fx.workspace.toLowerCase();

function worksInTest(name: string, fn: (lab: Lab) => Promise<void>, branch: (lab: Lab) => Record<string, unknown>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await openLab({}); // the workspace path is known once the lab exists: open, then set the replies
      try {
        await lab.page.eval(`localStorage.setItem('test-branch', ${JSON.stringify(JSON.stringify(branch(lab)))})`);
        await fn(lab);
        assertEquals(lab.page.errors, [], 'no console errors');
        const owner = await ownerProblems(lab.page);
        assert(!owner, owner);
      } finally {
        await lab.close();
      }
    },
  });
}

/** The New chat screen in the workspace project. */
async function newChat(page: Page) {
  await page.eval(`document.getElementById('new').click()`);
  await page.waitFor(`document.getElementById('title').textContent === 'New chat' && !!document.getElementById('chip-worksin')`, 15000, 'New chat');
}
const chipState = (page: Page) =>
  page.eval<{ text: string; value: string; locked: boolean; title: string; x: number; y: number; w: number; h: number; row: number; folder: string; note: string; amber: boolean }>(`(() => {
    const b = document.getElementById('chip-worksin'), r = b.getBoundingClientRect(), n = document.getElementById('ncWorksNote');
    const row = document.querySelector('.composer-row').getBoundingClientRect();
    return { text: b.textContent, value: b.querySelector('.chip-v').textContent, locked: b.classList.contains('chip-locked'),
      title: b.title, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), row: Math.round(row.height),
      folder: document.getElementById('ncFolder').firstChild ? document.getElementById('ncFolder').firstChild.textContent : '',
      note: n ? n.textContent : '', amber: !!n && n.classList.contains('amber') };
  })()`);
const menuRows = (page: Page) =>
  page.eval<{ name: string; desc: string; checked: boolean; disabled: boolean }[]>(`[...document.querySelectorAll('.chip-menu .chip-menu-item')].map((b) => ({
    name: b.querySelector('.chip-menu-name').textContent, desc: (b.querySelector('.chip-menu-desc') || {}).textContent || '',
    checked: b.getAttribute('aria-checked') === 'true', disabled: b.getAttribute('aria-disabled') === 'true' }))`);
async function openMenu(page: Page) {
  await page.click('#chip-worksin');
  await page.waitFor(`!!document.querySelector('.chip-menu .chip-menu-item')`, 5000, 'the Works in menu');
}
async function pick(page: Page, name: string) {
  await page.eval(`[...document.querySelectorAll('.chip-menu .chip-menu-item')].find((b) => b.querySelector('.chip-menu-name').textContent === ${JSON.stringify(name)}).click()`);
  await page.waitFor(`!document.querySelector('.chip-menu')`, 5000, 'menu closed');
}
const noDialog = (page: Page) =>
  page.eval<boolean>(`!document.querySelector('dialog[open]') && !document.querySelector('[role=alertdialog]:not([hidden])')`);

const git = (lab: Lab) => ({ [key(lab)]: { branch: 'main', copyable: true, whyNot: '' } });

worksInTest('20: "Works in: Project folder", the menu and its second lines, the folder line, and connect ownCopy', async (lab) => {
  const page = lab.page;
  await newChat(page);
  await page.waitFor(`!document.getElementById('chip-worksin').classList.contains('chip-locked')`, 15000, 'the folder answered');
  let s = await chipState(page);
  assertEquals(s.text.replace('▾', '').trim(), 'Works inProject folder');
  assert(s.folder.endsWith(' · main'), `folder line: ${s.folder}`);
  assertEquals(s.note, '', 'no note when nothing else works in the folder');
  const ids = await page.eval<string[]>(`[...document.querySelectorAll('#composerChips .chip')].map((c) => c.id || c.className)`);
  assert(ids.indexOf('chip-worksin') > ids.indexOf('chip-agent'), `the chip comes after the agent's: ${ids}`);
  await shot(page, '20-folder');
  await openMenu(page);
  assertEquals(await menuRows(page), [
    { name: 'Project folder', desc: 'Edits your files directly, like the agent in a terminal.', checked: true, disabled: false },
    { name: 'Own copy', desc: "Works on its own branch in a separate copy. You merge it when it's done.", checked: false, disabled: false },
  ]);
  await shot(page, '20-menu');
  await pick(page, 'Own copy');
  s = await chipState(page);
  assertEquals(s.value, 'Own copy');
  assert(s.folder.endsWith(' · own copy from main'), `folder line: ${s.folder}`);
  assertEquals(s.note, '', 'picked by hand: no pre-set reason');
  // the choice goes out with the first message
  await page.eval(`(() => { const p = document.getElementById('prompt'); p.value = 'hello'; p.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.eval(`document.getElementById('send').click()`);
  await page.waitFor(`window.__connects.length > 0`, 15000, 'connect sent');
  const sent = await page.eval<Record<string, unknown>>(`window.__connects[0]`);
  assertEquals(sent.ownCopy, true, JSON.stringify(sent));
  assertEquals(sent.resume, '');
  await settle(300);
}, git);

worksInTest('21 + 22: a busy folder chat pre-sets Own copy with the reason; no flip when it goes idle; Project folder turns the note amber, no dialog', async (lab) => {
  const page = lab.page;
  const busy: Chat = await lab.chat();
  await busy.start();
  busy.say('Working on it BUSYCHAT');
  await lab.select(busy);
  await newChat(page);
  await page.waitFor(`!document.getElementById('chip-worksin').classList.contains('chip-locked')`, 15000, 'the folder answered');
  let s = await chipState(page);
  assertEquals(s.value, 'Own copy', 'pre-set because another folder chat is working');
  assert(/^Own copy is on because “.+” is working in this folder\.$/.test(s.note), `note: ${s.note}`);
  assertEquals(s.amber, false);
  assert(s.folder.endsWith(' · own copy from main'), `folder line: ${s.folder}`);
  await shot(page, '21-preset');
  const before = s;

  // the other chat goes idle while the screen is open: nothing on screen changes [MF 9]
  busy.end();
  for (let i = 0; i < 60; i++) {
    const st = await lab.web.state(busy.id);
    if (!st.busy) break;
    await settle(250);
  }
  await settle(4000); // several list polls: the page knows it is idle now
  s = await chipState(page);
  assertEquals([s.value, s.note, s.x, s.y, s.w], [before.value, before.note, before.x, before.y, before.w], 'no flip, no move');

  // 22: the user turns it off: the amber note, no dialog
  await openMenu(page);
  await pick(page, 'Project folder');
  s = await chipState(page);
  assertEquals(s.value, 'Project folder');
  assertEquals(s.note, 'Both chats will edit the same files. If one runs tests or git while the other is mid-edit, things can break.');
  assertEquals(s.amber, true);
  const color = await page.eval<string>(`getComputedStyle(document.getElementById('ncWorksNote')).color`);
  const muted = await page.eval<string>(`getComputedStyle(document.getElementById('ncFolder')).color`);
  assert(color !== muted, `the amber note has its own colour (${color} vs ${muted})`);
  assert(await noDialog(page), 'no dialog');
  assert(s.folder.endsWith(' · main') && !s.folder.includes('own copy'), `folder line: ${s.folder}`);
  await shot(page, '22-amber');
  await settle(2000);
  assertEquals((await chipState(page)).note, s.note, 'the amber note stays');
}, git);

worksInTest('23: the slot is there before /branch answers (greyed, "Checking…"); no reflow when it answers', async (lab) => {
  const page = lab.page;
  await page.eval(`localStorage.setItem('test-branch', '{}')`); // held
  await newChat(page);
  await settle(400);
  const held = await chipState(page);
  assertEquals(held.locked, true, 'greyed while checking');
  assertEquals(held.value, 'Project folder');
  assert(held.title.includes('Checking…'), held.title);
  await openMenu(page);
  const rows = await menuRows(page);
  assertEquals(rows[1].desc, 'Checking…');
  assert(rows.every((r) => r.disabled), 'nothing to pick yet');
  await page.key('Escape');
  await shot(page, '23-checking');
  await page.eval(`localStorage.setItem('test-branch', ${JSON.stringify(JSON.stringify(git(lab)))})`);
  await page.waitFor(`!document.getElementById('chip-worksin').classList.contains('chip-locked')`, 15000, 'answered');
  const ready = await chipState(page);
  assertEquals([ready.x, ready.y, ready.w, ready.h, ready.row], [held.x, held.y, held.w, held.h, held.row], 'the same box: no reflow');
}, () => ({}));

worksInTest('23: a non-git folder keeps the chip greyed with whyNot', async (lab) => {
  const page = lab.page;
  await newChat(page);
  await page.waitFor(`document.getElementById('chip-worksin').title.includes('Not a git repository')`, 15000, 'answered');
  const s = await chipState(page);
  assertEquals([s.locked, s.value], [true, 'Project folder']);
  await openMenu(page);
  const rows = await menuRows(page);
  assertEquals(rows[1], { name: 'Own copy', desc: 'Not a git repository', checked: false, disabled: true });
  assertEquals(rows[0].disabled, false);
  await page.key('Escape');
  await shot(page, '23-not-git');
}, (lab) => ({ [key(lab)]: { branch: '', copyable: false, whyNot: 'Not a git repository' } }));

worksInTest('24: a folder chat\'s Changes tab: fixed header, no Merge or Discard, the footer line; an own-copy chat is unchanged', async (lab) => {
  const page = lab.page;
  const folder = await lab.chat();
  await folder.start();
  folder.say('Folder chat FOLDERCHAT');
  folder.end();
  const copy = await lab.chat(); // the same folder: its stubbed Changes reply carries a worktree, as an own-copy chat's does
  await copy.start();
  copy.say('Copy chat COPYCHAT');
  copy.end();
  const files = [{ path: 'src/app.ts', status: 'M', added: 4, removed: 1 }];
  await page.eval(`window.__changes = ${JSON.stringify({
    [folder.id]: { git: true, scope: 'uncommitted', files },
    [copy.id]: { git: true, scope: 'branch', files, worktree: { branch: 'studio/copy-1' } },
  })}`);
  await lab.select(folder);
  await page.eval(`document.getElementById('paneTab-changes').click()`);
  await page.waitFor(`document.querySelectorAll('#changesPane .cg-file').length === 1`, 15000, 'folder chat files');
  const f = await page.eval<{ scope: string; foot: string; footShown: boolean; merge: boolean; discard: boolean }>(`(() => {
    const p = document.getElementById('changesPane'), line = p.querySelector('.cg-foot-folder');
    return { scope: p.querySelector('.cg-scope').textContent, foot: line.hidden ? '' : line.textContent, footShown: !p.querySelector('.cg-foot').hidden,
      merge: !p.querySelector('.cg-merge-btn').hidden, discard: !p.querySelector('.cg-discard').hidden };
  })()`);
  assertEquals(f, {
    scope: 'Project folder · uncommitted',
    foot: "Works in the project folder · nothing to merge. The list holds this chat's and anyone else's uncommitted changes. Ask the agent to commit or undo them.",
    footShown: true,
    merge: false,
    discard: false,
  });
  // the header fits the column at its default width: nothing cut
  const fit = await page.eval<{ sw: number; cw: number; panel: number; sum: string }>(`(() => {
    const s = document.querySelector('#changesPane .cg-scope'), sum = document.querySelector('#changesPane .cg-sum');
    return { sw: s.scrollWidth, cw: s.clientWidth, panel: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
      sum: sum.scrollWidth <= sum.clientWidth ? 'whole' : 'cut' };
  })()`);
  assert(fit.panel <= 290, `the default panel width: ${fit.panel}`);
  assert(fit.sw <= fit.cw, `the header is cut at ${fit.panel} px: ${fit.sw} > ${fit.cw}`);
  assertEquals(fit.sum, 'whole', 'the file count is not cut either');
  await shot(page, '24-folder-changes');
  const panelW = await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`);

  await lab.select(copy);
  await page.waitFor(`document.querySelector('#changesPane .cg-scope').textContent === "This chat's changes"`, 15000, 'copy chat header');
  await page.waitFor(`!document.querySelector('#changesPane .cg-discard').hidden`, 15000, 'Discard as today');
  const c = await page.eval<{ foot: boolean; merge: boolean }>(`(() => {
    const p = document.getElementById('changesPane');
    return { foot: !p.querySelector('.cg-foot-folder').hidden, merge: !p.querySelector('.cg-merge-btn').hidden };
  })()`);
  assertEquals(c.foot, false, 'no folder line on an own-copy chat');
  await page.waitFor(`!document.querySelector('#changesPane .cg-merge-btn').hidden`, 15000, 'Merge as today').catch(() => 0);
  assertEquals(await page.eval<boolean>(`!document.querySelector('#changesPane .cg-merge-btn').hidden`), true, 'Merge as today');
  await shot(page, '24-copy-changes');
  assertEquals(
    await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`),
    panelW,
    'the right panel keeps its width when the chat changes',
  );
}, () => ({}));

worksInTest('21: the choice waits for the first chat list: greyed until then, then Own copy once, never Project folder first', async (lab) => {
  const page = lab.page;
  const busy: Chat = await lab.chat();
  await busy.start();
  busy.say('Working on it BUSYCHAT');
  // a fresh page whose first chat list is held: the branch reply is already there
  await page.eval(`localStorage.setItem('test-hold-list', '1')`);
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor(`!!document.getElementById('new')`, 15000, 'page');
  await page.eval(`document.getElementById('new').click()`);
  await page.waitFor(`!!document.getElementById('chip-worksin')`, 15000, 'the chip');
  await settle(800);
  const held = await chipState(page);
  assertEquals([held.locked, held.value], [true, 'Project folder'], 'greyed while the list is on its way');
  assert(held.title.includes('Checking…'), held.title);
  assertEquals(held.note, '', 'no note before the decision');
  await page.eval(`localStorage.removeItem('test-hold-list')`);
  await page.waitFor(`!document.getElementById('chip-worksin').classList.contains('chip-locked')`, 15000, 'decided');
  await settle(1500);
  const s = await chipState(page);
  assertEquals(s.value, 'Own copy');
  assert(/is working in this folder\.$/.test(s.note), s.note);
  const log = await page.eval<[boolean, string][]>(`window.__chipLog`);
  assert(!log.some(([locked, v]) => !locked && v === 'Project folder'), `never a pickable Project folder first: ${JSON.stringify(log)}`);
  assertEquals(log.filter(([locked]) => !locked).map(([, v]) => v), ['Own copy'], `decided once: ${JSON.stringify(log)}`);
  busy.end();
}, git);
