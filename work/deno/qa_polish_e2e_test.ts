/**
 * QA polish batch, end to end: a real Studio server + headless Chrome/Edge (own temp profile and data folder, free ports, no agent
 * runs) on a temp git repo with one saved chat.
 *   Q1  Files: "New doc" makes the doc and aib-docs lists it at once (first doc, then a second), also after collapse/re-expand.
 *   Q2  A doc tab whose chat is gone opens from the project folder (docs belong to the project), after a reload.
 *   Q6  At 860 px the sidebar drawer stays open after "Git exclude" so the "Excluded x" foot with Undo shows.
 * AIB_DOCPAGE_SHOTS=<folder> keeps a screenshot per step.
 */
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { assert, assertEquals } from './_assert.ts';
import { git, HAVE_GIT } from './_git_repo.ts';
import { Fixture, SEP, TEST_OPTIONS } from './_host_fixture.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';

const key = (path: string) => 'w:' + path.replaceAll('\\', '/').toLowerCase();

function transcript(claude: string, id: string, cwd: string, text: string): void {
  const stamp = new Date(Date.now() - 60_000).toISOString();
  const rows = [
    { type: 'user', sessionId: id, cwd, timestamp: stamp, message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: id, cwd, timestamp: stamp, message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  const dir = `${claude}${SEP}enc-${id}`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(`${dir}${SEP}${id}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

for (const wt of [false, true]) {
Deno.test({
  name: `QA polish (${wt ? "chat in its own copy" : 'chat in the main folder'}): new docs list at once, a doc tab with no chat opens from the project, Git exclude keeps the narrow drawer open`,
  ignore: !browserPath || !HAVE_GIT,
  ...TEST_OPTIONS,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 8 minutes')), 8 * 60_000);
    });
    await using fx = new Fixture();
    let browser: Browser | undefined;
    try {
      await Promise.race([deadline, run(fx, (b) => (browser = b), wt)]);
    } finally {
      clearTimeout(giveUp);
      await browser?.close();
    }
  },
});
}

const rowPaths = (page: Page) => page.eval<string[]>(`Array.from(document.querySelectorAll('.fx-row[data-path]')).map((n) => n.dataset.path)`);

async function newDoc(page: Page, name: string): Promise<void> {
  await page.eval(`AgentFilesUI.startNewDoc ? AgentFilesUI.startNewDoc() : document.querySelector('.fx-newdoc, .fx-row[data-path="aib-docs/+new-doc"]').click()`);
  await page.waitFor(`!!document.querySelector('.fx-newdoc-in')`, 10_000, 'the name field');
  await page.eval(`(() => { const i = document.querySelector('.fx-newdoc-in'); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
}

async function run(fx: Fixture, keep: (b: Browser) => void, wt: boolean): Promise<void> {
  const r = fx.root;
  const alpha = `${r}${SEP}Empty Project`;
  Deno.mkdirSync(alpha, { recursive: true });
  git(alpha, 'init', '-q');
  Deno.writeTextFileSync(`${alpha}${SEP}README.md`, '# alpha\n');
  Deno.writeTextFileSync(`${alpha}${SEP}scratch.md`, 'untracked\n');
  git(alpha, 'add', 'README.md');
  git(alpha, 'commit', '-q', '-m', 'base');
  let copy = alpha;
  if (wt) {
    copy = `${r}${SEP}copies${SEP}chat-5e1f`;
    Deno.mkdirSync(`${r}${SEP}copies`);
    git(alpha, 'worktree', 'add', '-q', '-b', 'studio/chat-5e1f', copy);
    Deno.writeTextFileSync(
      `${fx.state}${SEP}studio-worktrees.json`,
      JSON.stringify({ version: 1, worktrees: { k1: { path: copy, project: alpha, status: 'ready', branch: 'studio/chat-5e1f', session: 's-1' } } }),
    );
  }
  Deno.writeTextFileSync(`${copy}${SEP}extra.txt`, 'only here\n');
  transcript(`${r}${SEP}claude`, 's-1', copy, 'Plan the release');
  const added: Record<string, { path: string; at: number }> = { [projectKey(alpha)]: { path: alpha, at: 1 } };
  Deno.writeTextFileSync(`${fx.state}${SEP}studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, added }));
  const ALPHA = key(alpha);
  const ws = { v: 1, active: ALPHA, tabs: { [ALPHA]: ['claude:s-1'] }, last: { [ALPHA]: 'claude:s-1' }, recent: ALPHA };
  Deno.writeTextFileSync(
    `${fx.state}${SEP}studio-view.json`,
    JSON.stringify({ version: 1, savedAt: 1, prefs: { 'studio-workspace-v1': JSON.stringify(ws), 'aib-theme': 'teal-light' } }),
  );
  const home = `${r}${SEP}home`;
  for (const d of ['appdata', 'localappdata', 'home']) Deno.mkdirSync(`${r}${SEP}${d}`, { recursive: true });
  const web = await fx.startWeb(['--in-process', '--no-auto-reconnect'], {
    env: {
      USERPROFILE: home,
      HOME: home,
      APPDATA: `${r}${SEP}appdata`,
      LOCALAPPDATA: `${r}${SEP}localappdata`,
      CODEX_HOME: `${home}${SEP}.codex`,
      AIB_UPDATE_API_BASE: 'http://127.0.0.1:9',
    },
  });
  const browser = await Browser.launch();
  keep(browser);
  const port = web.port;
  const page = await browser.open(`http://127.0.0.1:${port}/`, 1600, 900);
  await page.waitFor(`document.getElementById('title').textContent === 'Plan the release'`, 30_000, 'the chat open');
  await page.eval(`AgentFilesUI.setMode('files')`);
  await page.waitFor(`!!document.querySelector('.fx-row[data-path="README.md"]')`, 20_000, 'files listed');

  const geo = await page.eval<Record<string, number | string>>(`(() => { const n = document.getElementById('wsListName'), b = document.getElementById('wsProjectBtn'), p = document.getElementById('wsRenameProj'), a = document.getElementById('wsNewProject');
    const bb = b.getBoundingClientRect(), pb = p.getBoundingClientRect(), ab = a.getBoundingClientRect(), nb = n.getBoundingClientRect();
    return { text: n.textContent, scroll: n.scrollWidth, client: n.clientWidth, btnL: bb.left, btnR: bb.right, nameL: nb.left, nameR: nb.right, pencilL: pb.left, plusL: ab.left, side: document.querySelector('aside').getBoundingClientRect().width }; })()`);
  assert(Number(geo.scroll) <= Number(geo.client), `Q7: the project title "${geo.text}" is cut (${geo.scroll} > ${geo.client}): ${JSON.stringify(geo)}`);
  // Q3: the right column's three tab labels show in full beside the widen button (all three badges lit, on the Changes tab)
  const tabGeo = () =>
    page.eval<Record<string, unknown>>(`(() => { const t = document.getElementById('paneTabs');
      const out = { tabsW: t.clientWidth, tabsScroll: t.scrollWidth, tabs: [] };
      for (const b of t.querySelectorAll('.pane-tab')) { const l = b.querySelector('.pane-tab-label');
        out.tabs.push({ id: b.dataset.tab, w: Math.round(b.getBoundingClientRect().width), label: l.textContent, cut: l.scrollWidth > l.clientWidth }); }
      const e = t.querySelector('.pane-expand').getBoundingClientRect(); out.expandRight = Math.round(e.right); out.colRight = Math.round(t.getBoundingClientRect().right);
      return out; })()`);
  await page.eval(`document.getElementById('paneTab-changes').click(); for (const b of document.querySelectorAll('#paneTabs .pane-badge')) { b.hidden = false; b.textContent = '5'; }`);
  await page.waitFor(`!document.querySelector('#paneTabs .pane-expand').hidden`, 10_000, 'the widen button');
  const tg = await tabGeo();
  for (const t of tg.tabs as { id: string; cut: boolean }[]) assert(!t.cut, `Q3: the ${t.id} label is cut: ${JSON.stringify(tg)}`);
  assert(Number(tg.tabsScroll) <= Number(tg.tabsW), `Q3: the tab row overflows: ${JSON.stringify(tg)}`);
  assert(Number(tg.expandRight) <= Number(tg.colRight), `Q3: the widen button is pushed out: ${JSON.stringify(tg)}`);
  await page.shot('q3-right-tabs');
  // Q1: first doc, then a second; each shows in aib-docs at once, and after collapse / re-expand
  await newDoc(page, 'First plan');
  await page.waitFor(`document.querySelector('.fx-tab, [data-tab-kind="doc"]') !== null || true`, 1000, 'x');
  await page.eval(`AgentFilesUI.setMode('files')`);
  await page.eval(`window.AgentWorkspaceUI && AgentWorkspaceUI.openDrawer && AgentWorkspaceUI.openDrawer()`);
  await page.waitFor(`!!document.querySelector('.fx-row.fx-docsdir, .fx-row[data-path="aib-docs"]')`, 10_000, 'aib-docs row');
  await page.waitFor(`!!document.querySelector('.fx-row.fx-doc')`, 10_000, 'the new doc listed under aib-docs');
  await page.shot('q1-first-doc');
  assert((await rowPaths(page)).some((p) => p === 'aib-docs/first-plan'), JSON.stringify(await rowPaths(page)));
  await newDoc(page, 'Second plan');
  await page.waitFor(`document.querySelectorAll('.fx-row.fx-doc').length === 2`, 10_000, 'two docs listed');
  assert((await page.eval<string>(`document.querySelector('.fx-docscount').textContent`)).trim().startsWith('2 docs'), 'the count says 2 docs');
  // collapse and expand again: both docs, no "Not found"
  await page.eval(`document.querySelector('.fx-row[data-path="aib-docs"]').click()`);
  await page.waitFor(`document.querySelectorAll('.fx-row.fx-doc').length === 0`, 10_000, 'aib-docs collapsed');
  await page.eval(`document.querySelector('.fx-row[data-path="aib-docs"]').click()`);
  await page.waitFor(`document.querySelectorAll('.fx-row.fx-doc').length === 2`, 10_000, 'aib-docs expanded again');
  assert(!(await page.eval<string>(`document.getElementById('wsAsideMain').textContent`)).includes('Not found'), 'no Not found');
  await page.shot('q1-two-docs');

  // Q2: the chat is gone (a restored tab names a chat that does not exist any more): the doc opens from the project folder
  const tabs = await page.eval<string>(`localStorage.getItem('aib-file-tabs-v1')`);
  assert(tabs.includes('doc|first-plan') && tabs.includes('"path":'), tabs);
  for (const variant of ['with the project path', 'an old tab without it']) {
    const gone = JSON.parse(tabs);
    for (const pk of Object.keys(gone)) {
      for (const t of gone[pk].tabs) {
        t.scope.id = 'claude:gone-chat';
        if (variant !== 'with the project path') delete t.scope.path;
      }
    }
    await page.eval(`localStorage.setItem('aib-file-tabs-v1', ${JSON.stringify(JSON.stringify(gone))})`);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitFor(`document.getElementById('title').textContent === 'Plan the release'`, 30_000, 'the chat open again');
    await page.waitFor(`!!document.querySelector('.sf-doctab')`, 10_000, `the restored doc tab (${variant})`);
    await page.eval(`document.querySelector('.sf-doctab .ws-tab-main, .sf-doctab button').click()`);
    const shown = `(() => { const f = document.querySelector('iframe.sf-docframe:not([hidden])'); const d = f && f.contentDocument;
      return !!d && !!d.getElementById('docTitle') && d.getElementById('docTitle').textContent.trim() !== '' && d.getElementById('docError').hidden; })()`;
    await page.waitFor(shown, 20_000, `the doc opens with no chat (${variant})`);
    const err = await page.eval<string>(`document.querySelector('iframe.sf-docframe:not([hidden])').contentDocument.getElementById('docError').textContent`);
    assertEquals(err, '', 'no error text');
    await page.shot('q2-doc-tab-no-chat');
  }

  // Q6: at the narrowest layout the sidebar drawer stays open after "Git exclude" (a Files action, not navigation), so the foot shows
  await page.viewport(860, 900);
  // the narrowest layout: if the tab row shows at all, nothing in it overflows or is cut
  const narrowTabs = await page.eval<{ shown: boolean; over: boolean }>(`(() => { const t = document.getElementById('paneTabs'); const r = t.getBoundingClientRect();
    return { shown: r.width > 0 && r.height > 0, over: t.scrollWidth > t.clientWidth + 1 || Array.from(t.querySelectorAll('.pane-tab-label')).some((l) => l.scrollWidth > l.clientWidth) }; })()`);
  assert(!narrowTabs.over, 'Q3: the tab row overflows at 860 px: ' + JSON.stringify(narrowTabs));
  await page.eval(`AgentFilesUI.setMode('files'); AgentWorkspaceUI.openDrawer()`);
  await page.waitFor(`document.body.classList.contains('ws-list-open') && !!document.querySelector('.fx-row[data-path="extra.txt"]')`, 10_000, 'the drawer with the tree');
  await page.shot('q6-drawer-before');
  const [rx, ry] = await page.eval<number[]>(`(() => { const r = document.querySelector('.fx-row[data-path="extra.txt"]').getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2]; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: rx, y: ry, button: 'right', buttons: type === 'mouseReleased' ? 0 : 2, clickCount: 1 });
  }
  await page.waitFor(`!!document.querySelector('.fx-menu .fx-menu-excl')`, 10_000, 'the row menu');
  assertEquals(await page.eval(`document.body.classList.contains('ws-list-open')`), true, 'the drawer stays open when the row menu opens');
  await page.click('.fx-menu .fx-menu-excl'); // a real mouse click
  await page.waitFor(`!document.querySelector('.fx-foot-undo').hidden`, 10_000, 'the Undo in the foot').catch(async (e) => {
    throw new Error(`${e.message}; foot: ${await page.eval(`document.querySelector('.fx-foot-t').textContent`)}; drawer: ${await page.eval(`document.body.className`)}`);
  });
  assertEquals(await page.eval(`document.body.classList.contains('ws-list-open')`), true, 'the drawer stays open after Git exclude');
  assertEquals(await page.eval(`document.querySelector('.fx-foot-t').textContent`), 'Excluded extra.txt');
  await page.shot('q6-drawer-after-exclude');
  assertEquals(page.errors, [], 'no page errors');
}
