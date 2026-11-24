/**
 * T14 (multi-window design section 11, Phase 2.5B): the doc pop-out, headless, against a Studio in this process with the fake
 * K4 (work/deno/_fake_desktop_windows.ts) standing in for the desktop app's windows. No window is shown on screen.
 *
 *  - A pop-out (/doc.html?w=&kind=doc&project=<key>&name=<doc>) opens the doc by project key and name (no chat id, so a restart's
 *    new live ids cannot break it), reports itself in presence, writes no layout keys, and does the parent-frame asks itself:
 *    "Open it" routes (K3 op 'route'), "Send to a chat…" lists the project's chats here, a doc moved to the trash closes its own
 *    window, and "Show in Files" / "Pop out" are not in its ⋯ menu.
 *  - The move (owner decision 4): "Pop out" in a doc tab's ⋯ menu asks for the doc window (op 'popout' by project + name), the
 *    tab closes in the project window, the Files row shows ↗, opening the doc again brings the pop-out forward, and closing the
 *    pop-out puts the tab back as a background tab.
 *
 * Run (from app): deno test -A ../../work/deno/doc_popout_e2e_test.ts
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { remoteStudio } from './_remote_fixture.ts';
import { FakeDesktopWindows } from './_fake_desktop_windows.ts';
import { projectKey } from '../../app/server/desktop/project_delete.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The app page (its bridge function bound, so it counts as an app window); focus under the test's control.
const APP_PAGE = [
  'window.bindings = { aibDesktop() {} };',
  'window.__focus = false;',
  'Document.prototype.hasFocus = function () { return !!window.__focus; };',
  "Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible' });",
  "Object.defineProperty(Document.prototype, 'hidden', { get: () => false });",
].join('\n');

async function lab() {
  const s = await remoteStudio({}, undefined, { saved: true }); // the project is an added one
  const dw = new FakeDesktopWindows();
  s.ctx.desktopWindows = dw;
  s.ctx.transcripts = {
    root: s.state,
    sessions: () => Promise.resolve([]),
    agents: () => Promise.resolve([]),
    sessionCwd: () => Promise.resolve(null),
  } as unknown as typeof s.ctx.transcripts;
  s.chats.push({
    id: 'c1',
    provider: 'claude',
    sessionId: 'sess-1',
    cwd: s.project,
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null } as Json,
    subagents: {},
    breadth: { sessionInfo: { title: 'Checkout work' } },
    events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'hello' } }] as Json[],
    permissions: [] as Json[],
    elicitations: [],
  } as unknown as (typeof s.chats)[number]);
  const pk = projectKey(s.project);
  await s.ctx.docs.open(s.project, 'Release plan', '# Release plan\n\nShip the checkout on Friday.\n', 'user');
  const browser = await Browser.launch();
  const base = `http://127.0.0.1:${s.port}`;
  const popUrl = (w: string, name = 'Release plan') =>
    `${base}/doc.html?${new URLSearchParams({ w, kind: 'doc', project: pk, name })}`;
  return {
    s,
    dw,
    pk,
    browser,
    base,
    popUrl,
    async close() {
      await browser.close();
      await s.close();
    },
  };
}

const editorReady = (p: Page) =>
  p.waitFor(`!!(window.AIBDoc && window.AIBDoc.editor && document.querySelector('#docEditor .ProseMirror'))`, 15000, 'the doc editor');
const storageKeys = (p: Page) => p.eval<string[]>('Object.keys(localStorage).sort()');
// What a doc page may keep: per-doc things (its last page, its open toggles). Never a layout key, never the page session (memory only).
const docOnly = (k: string) => k.startsWith('aib-doc-page:') || k.startsWith('aib-doc-toggles:');

Deno.test({
  ...OPTS,
  name: 'doc pop-out: opens by project key and name, reports itself, writes no layout, and does the parent-frame asks itself',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const made = await t.dw.open({ doc: { project: t.pk, name: 'Release plan' } }, 'm');
      assertEquals(made.w, 'w2');
      const page = await t.browser.open('about:blank', 720, 900);
      await page.goto(t.popUrl('w2'));
      await editorReady(page);
      const st = await page.eval<Json>(`(() => ({
        popout: AIBDoc.popout, framed: AIBDoc.framed, chatId: AIBDoc.chatIdNow(), cls: document.documentElement.classList.contains('doc-popout'),
        text: document.querySelector('#docEditor').innerText, title: document.title,
      }))()`);
      assertEquals(st.popout, true, 'pop-out mode');
      assertEquals(st.framed, false);
      assertEquals(st.cls, true);
      assert(String(st.text).includes('Ship the checkout'), `the doc shows: ${st.text}`);
      assertEquals(st.chatId, 'project:' + t.s.project, 'later calls ask with the project id the server named');
      assert(/^Release plan/.test(String(st.title)), `title ${st.title}`);

      // presence: the server knows window w2 shows this doc
      const end = Date.now() + 8000;
      let mine: Json | undefined;
      while (Date.now() < end) {
        mine = t.s.ctx.presence.windows().find((x) => x.w === 'w2') as Json | undefined;
        if (mine) break;
        await sleep(100);
      }
      assert(mine, 'the pop-out reported presence');
      assertEquals(mine!.kind, 'doc');
      assertEquals(mine!.doc, { project: t.pk, name: 'Release plan' });

      // no layout keys: only the page session and per-doc state, also after a resize
      await page.viewport(500, 700);
      await sleep(400);
      const keys = await storageKeys(page);
      assertEquals(keys.filter((k) => !docOnly(k)), [], `layout keys written: ${keys.join(', ')}`);

      // the ⋯ menu: no "Show in Files" (no Files panel) and no "Pop out" (it is the pop-out)
      await page.click('#btnMore');
      const acts = await page.eval<string[]>(`[...document.querySelectorAll('.more-menu [data-act]')].map((b) => b.dataset.act)`);
      assert(acts.includes('duplicate') && acts.includes('trash'), `menu: ${acts}`);
      assert(!acts.includes('files') && !acts.includes('popout'), `menu: ${acts}`);
      await page.eval('AIBDoc.closeMenu(), true');

      // "Open it" (Duplicate's toast) goes through the route to the project's window, never into this one
      await page.eval(`AIBDoc.tell({ type: 'aib-doc:open', name: 'Release plan copy', where: 'tab' }), true`);
      const end2 = Date.now() + 8000;
      while (!t.dw.delivered.length && Date.now() < end2) await sleep(100);
      assertEquals(t.dw.delivered, [['m', { project: t.pk, doc: { project: t.pk, name: 'Release plan copy' } }]]);

      // "Send to a chat…": the project's open chats, picked here
      const picking = page.eval<string | null>(`AIBDoc.pickChat('send')`);
      await page.waitFor(`!!document.querySelector('.pick-menu .mi:not(:disabled)')`, 8000, 'the chat menu');
      const label = await page.eval<string>(`document.querySelector('.pick-menu .mi:not(:disabled)').textContent`);
      assert(label.includes('Checkout work'), `the chat row: ${label}`);
      await page.eval(`document.querySelector('.pick-menu .mi:not(:disabled)').click(), true`);
      assertEquals(await picking, 'c1');

      // moved to the trash (the socket says closed): the line shows, then the window closes itself (op 'close')
      await page.eval(`AIBDoc.tell({ type: 'aib-doc:closed' }), true`);
      const end3 = Date.now() + 8000;
      while (t.dw.windows.some((x) => x.w === 'w2') && Date.now() < end3) await sleep(100);
      assert(!t.dw.windows.some((x) => x.w === 'w2'), 'the pop-out closed itself');
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'doc pop-out: an unknown project key is refused; a known one opens with no chat at all (restart-proof address)',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const post = (body: Json) =>
        fetch(`${t.base}/api/live/docs/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Studio-Token': t.s.token, Origin: t.base },
          body: JSON.stringify(body),
        }).then(async (r) => [r.status, await r.json()] as [number, Json]);
      const [bad, badBody] = await post({ project: 'w:c:/no/such/project', name: 'Release plan' });
      assertEquals([bad, badBody.code], [404, 'unknown_folder']);
      const [ok, okBody] = await post({ project: t.pk, name: 'Release plan' });
      assertEquals(ok, 200, JSON.stringify(okBody));
      assertEquals(okBody.name, 'release-plan', 'the doc found by its title too');
      assertEquals(okBody.projectId, 'project:' + t.s.project);
      // by key never makes a doc
      const [none] = await post({ project: t.pk, name: 'Not a doc', create: '' });
      assert(none !== 200, 'no doc made by key');
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'doc pop-out moves the doc: the tab closes, the Files row shows ↗, opening it focuses the pop-out, closing it puts the tab back',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const a = await t.browser.open('about:blank', 1400, 900);
      await a.send('Page.addScriptToEvaluateOnNewDocument', { source: APP_PAGE });
      await a.goto(`${t.base}/?w=m`);
      await a.waitFor('!!window.AibWindow && !!window.AgentFilesUI && window.AibDesktop.available()', 15000, 'the app page');
      await a.waitFor('!!document.querySelector(\'button.connection[data-key="claude:sess-1"]\')', 20000, 'the chat in the list');
      await a.click('button.connection[data-key="claude:sess-1"]');
      await a.waitFor('JSON.stringify(window.AgentWorkspaceUI.openKeys()) === \'["claude:sess-1"]\'', 10000, 'the chat open');
      assertEquals(await a.eval('window.AgentWorkspaceUI.currentProject()'), t.pk);
      // the doc in a tab
      await a.eval(`AgentFilesUI.openDoc(AgentFilesUI.currentScope(), { name: 'release-plan', title: 'Release plan', where: 'tab' }), true`);
      await a.waitFor(
        `(() => { const f = document.querySelector('iframe.sf-docframe'); const w = f && f.contentWindow; return !!(w && w.AIBDoc && w.AIBDoc.editor); })()`,
        20000,
        'the doc tab',
      );
      const tabsBefore = await a.eval<Json>('AgentFilesUI._state().tabs');
      assert((tabsBefore.tabs as Json[]).some((x) => x.kind === 'doc'), 'a doc tab');
      // its ⋯ menu has Pop out
      await a.eval(`document.querySelector('iframe.sf-docframe').contentDocument.getElementById('btnMore').click(), true`);
      await a.waitFor(
        `!!document.querySelector('iframe.sf-docframe').contentDocument.querySelector('.more-menu [data-act="popout"]')`,
        5000,
        'Pop out in the menu',
      );
      await a.eval(`document.querySelector('iframe.sf-docframe').contentDocument.querySelector('.more-menu [data-act="popout"]').click(), true`);
      const end = Date.now() + 8000;
      while (!t.dw.windows.some((x) => x.kind === 'doc') && Date.now() < end) await sleep(100);
      const win = t.dw.windows.find((x) => x.kind === 'doc');
      assert(win, 'a doc window was asked for');
      assertEquals(win!.doc, { project: t.pk, name: 'release-plan' }, 'by project key and doc name');
      assert(win!.url.includes('/doc.html?') && !win!.url.includes('chat='), `its address: ${win!.url}`);
      // the tab left this window; the chat shows again
      await a.waitFor(`!AgentFilesUI._state().tabs.tabs.some((x) => x.kind === 'doc')`, 5000, 'the doc tab closed');
      assertEquals(await a.eval('document.querySelectorAll("iframe.sf-docframe").length'), 0, 'its frame went too');
      assert(await a.eval<boolean>(`!!AgentDocLinks.poppedOut(${JSON.stringify(t.pk)}, 'release-plan')`), 'remembered as popped out');

      // the Files row: ↗
      await a.eval(`AgentFilesUI.setMode('files'), true`);
      await a.waitFor(`!!document.querySelector('.fx-row[data-path="aib-docs"], .fx-doc')`, 10000, 'the docs folder in Files');
      if (!(await a.eval<boolean>(`!!document.querySelector('.fx-doc')`))) await a.click('.fx-row[data-path="aib-docs"]');
      await a.waitFor(`!!document.querySelector('.fx-doc')`, 10000, 'the doc row').catch(async (e) => {
        console.log(await a.eval('document.querySelector(".fx-pane, #filesPane, .fx") ? (document.querySelector(".fx-pane, #filesPane, .fx").innerText) : document.body.innerText.slice(0, 2000)'));
        throw e;
      });
      await a.waitFor(`!!document.querySelector('.fx-doc .fx-docpop')`, 10000, 'the ↗ on the doc row').catch(async (e) => {
        console.log(await a.eval(`JSON.stringify({ pops: AgentDocLinks._pops(), row: document.querySelector('.fx-doc').outerHTML, pk: AgentWorkspaceUI.currentProject() })`));
        throw e;
      });
      assertEquals(await a.eval('document.querySelector(".fx-doc.popped .fx-docpop").textContent'), '↗');

      // the pop-out itself: it reports presence, so the project window sees it
      const pop = await t.browser.open('about:blank', 720, 900);
      await pop.goto(t.popUrl(win!.w, win!.doc!.name));
      await editorReady(pop);
      await a.eval('window.AgentNotifyUI.reportPresence(true), true');
      await a.waitFor(
        `(() => { const p = AgentDocLinks._pops()[0]; return !!p && p.seen && p.w === ${JSON.stringify(win!.w)}; })()`,
        10000,
        'the project window saw the pop-out',
      );

      // opening the doc again (a Files row click) brings the pop-out forward, no second copy
      const focusedBefore = t.dw.focused.length;
      await a.click('.fx-doc');
      const end2 = Date.now() + 5000;
      while (t.dw.focused.length === focusedBefore && Date.now() < end2) await sleep(100);
      assertEquals(t.dw.focused.at(-1), win!.w, 'the pop-out came forward');
      await sleep(300);
      assert(!(await a.eval<boolean>(`AgentFilesUI._state().tabs.tabs.some((x) => x.kind === 'doc')`)), 'no tab opened');

      // closing the pop-out (its pagehide): the tab comes back in the background; the active tab stays as it was
      const activeBefore = await a.eval<string>('AgentFilesUI._state().tabs.active');
      await pop.goto('about:blank');
      await a.waitFor(`AgentFilesUI._state().tabs.tabs.some((x) => x.kind === 'doc')`, 10000, 'the doc tab is back');
      assertEquals(await a.eval('AgentFilesUI._state().tabs.active'), activeBefore, 'in the background');
      assertEquals(await a.eval('AgentDocLinks._pops().length'), 0, 'no longer popped out');
      assertEquals(await a.eval('document.querySelectorAll(".fx-docpop").length'), 0, 'the ↗ is gone');
      assertEquals(a.errors, [], 'console errors (project window)');
      assertEquals(pop.errors, [], 'console errors (pop-out)');
      await pop.close();
      await a.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'doc pop-out after a restart: the restored pop-out names the window it came from; closing it puts the tab back there',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      await t.s.ctx.docs.open(t.s.project, 'Notes', '# Notes\n\nNot this window.\n', 'user');
      // as restored from desktop-windows.json: the doc pop-out w2 was moved out of the main window before the restart (the chat
      // ids of that run are gone); w3 was moved out of another window, so it is not this window's to take back
      t.dw.restore({ w: 'w2', kind: 'doc', project: t.pk, name: 'release-plan' }, 'Release plan · AIB', 'm');
      t.dw.restore({ w: 'w3', kind: 'doc', project: t.pk, name: 'notes' }, 'Notes · AIB', 'w5');
      const a = await t.browser.open('about:blank', 1400, 900);
      await a.send('Page.addScriptToEvaluateOnNewDocument', { source: APP_PAGE });
      await a.goto(`${t.base}/?w=m`); // a fresh page: no sessionStorage record of the move
      await a.waitFor('!!window.AibWindow && !!window.AgentFilesUI && window.AibDesktop.available()', 15000, 'the app page');
      await a.waitFor('!!document.querySelector(\'button.connection[data-key="claude:sess-1"]\')', 20000, 'the chat in the list');
      await a.click('button.connection[data-key="claude:sess-1"]');
      await a.waitFor('JSON.stringify(window.AgentWorkspaceUI.openKeys()) === \'["claude:sess-1"]\'', 10000, 'the chat open');
      // the restored pop-outs load and report themselves (presence)
      const pop = await t.browser.open('about:blank', 720, 900);
      await pop.goto(t.popUrl('w2', 'release-plan'));
      await editorReady(pop);
      const other = await t.browser.open('about:blank', 720, 900);
      await other.goto(t.popUrl('w3', 'notes'));
      await editorReady(other);
      await a.eval('window.AgentNotifyUI.reportPresence(true), true');
      await a.waitFor(
        `(() => { const p = AgentDocLinks._pops(); return p.length === 1 && p[0].name === 'release-plan' && p[0].seen && p[0].w === 'w2'; })()`,
        10000,
        'taken back as its own',
      ).catch(async (e) => {
        console.log(await a.eval(`JSON.stringify({ pops: AgentDocLinks._pops(), ans: AibWindow.answer() })`));
        throw e;
      });
      assert(await a.eval<boolean>(`!!AgentDocLinks.poppedOut(${JSON.stringify(t.pk)}, 'release-plan')`), 'remembered as popped out');
      assert(!(await a.eval<boolean>(`AgentFilesUI._state().tabs.tabs.some((x) => x.kind === 'doc')`)), 'no doc tab yet');
      // closing the pop-out: its tab comes back here in the background, with this run's chat (never the old run's id)
      const activeBefore = await a.eval<string>('AgentFilesUI._state().tabs.active');
      await pop.goto('about:blank');
      t.dw.close('w2');
      await a.eval('window.AgentNotifyUI.reportPresence(true), true');
      await a.waitFor(`AgentFilesUI._state().tabs.tabs.some((x) => x.kind === 'doc')`, 10000, 'the doc tab is back');
      const tab = await a.eval<Json>(`AgentFilesUI._state().tabs.tabs.find((x) => x.kind === 'doc')`);
      assertEquals((tab.doc as Json).name, 'release-plan');
      assertEquals((tab.doc as Json).title, 'Release plan', 'its title, from the doc list');
      assertEquals((tab.scope as Json).id, 'c1', 'the live chat of the project now');
      assertEquals(await a.eval('AgentFilesUI._state().tabs.active'), activeBefore, 'in the background');
      assertEquals(await a.eval('AgentDocLinks._pops().length'), 0, 'no longer popped out');
      // the other window's pop-out was never taken: closing it brings nothing here
      await other.goto('about:blank');
      t.dw.close('w3');
      await a.eval('window.AgentNotifyUI.reportPresence(true), true');
      await sleep(800);
      assertEquals(await a.eval<number>(`AgentFilesUI._state().tabs.tabs.filter((x) => x.kind === 'doc').length`), 1, 'only its own doc came back');
      assertEquals(a.errors, [], 'console errors (project window)');
      assertEquals(pop.errors, [], 'console errors (pop-out)');
      await pop.close();
      await other.close();
      await a.close();
    } finally {
      await t.close();
    }
  },
});
