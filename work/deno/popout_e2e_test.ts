/**
 * T12 (multi-window design section 11, Phase 2.5A): the chat pop-out, headless, against a Studio in this process with the fake
 * K4 (work/deno/_fake_desktop_windows.ts) standing in for the desktop app's windows. No window is shown on screen.
 *
 *  - The pop-out page (/?w=&kind=chat&mode=chat&chat=<lasting key>&project=) opens its chat by the lasting key (provider:session,
 *    never a live id, so a restart's new live ids cannot break it), hides the sidebar / tabs / Activity, writes no layout keys
 *    (also after a resize), reports itself in presence (kind chat + its chat), its composer sends, Ctrl+Shift+N and Ctrl+P do
 *    nothing, a desktop notification for its chat is 'mine' and for another chat 'no' (K6), a routed project or doc is 'no', and
 *    its chat gone closes its own window (op 'close').
 *  - The move (owner decision 4): "Pop out" in a chat tab's menu asks for the chat window (op 'popout' by the lasting key), the
 *    tab closes in the project window (the active tab stays), the sidebar row shows ↗, a notification for it is 'no' there,
 *    clicking the row brings the pop-out forward, and closing the pop-out puts the tab back as a background tab.
 *  - Routed opens from the desktop app (K3 route, K6): {type:'project'} switches the main window to it, {type:'doc'} opens the
 *    doc there; a project window says 'no' to another project.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/popout_e2e_test.ts
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { remoteStudio } from './_remote_fixture.ts';
import { FakeDesktopWindows } from './_fake_desktop_windows.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { windowPath } from '../../outputs/agent-studio/server/desktop/windows_contract.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The app page (its bridge function bound, so it counts as an app window); visible, focus under the test's control.
const APP_PAGE = [
  'window.bindings = { aibDesktop() {} };',
  'window.__winCalls = [];',
  'const __f = window.fetch.bind(window);',
  "window.fetch = async (u, o) => { const r = await __f(u, o); if (String(u).includes('/api/live/desktop/windows')) window.__winCalls.push({ body: JSON.parse(o.body), status: r.status }); return r; };",
  'window.__focus = false;',
  'Document.prototype.hasFocus = function () { return !!window.__focus; };',
  "Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible' });",
  "Object.defineProperty(Document.prototype, 'hidden', { get: () => false });",
].join('\n');

const K1 = 'claude:sess-1',
  K2 = 'claude:sess-2';

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
  const chat = (n: number, title: string) =>
    ({
      id: 'c' + n,
      provider: 'claude',
      sessionId: 'sess-' + n,
      cwd: s.project,
      busy: false,
      closed: false,
      attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null } as Json,
      subagents: {},
      breadth: { sessionInfo: { title } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }] as Json[],
      permissions: [] as Json[],
      elicitations: [],
    }) as unknown as (typeof s.chats)[number];
  s.chats.push(chat(1, 'Checkout work'), chat(2, 'Billing export'));
  const pk = projectKey(s.project);
  await s.ctx.docs.open(s.project, 'Release plan', '# Release plan\n\nShip the checkout on Friday.\n', 'user');
  const browser = await Browser.launch();
  const base = `http://127.0.0.1:${s.port}`;
  const popUrl = (w: string, key = K1) => base + windowPath({ w, kind: 'chat', chat: key, project: pk });
  const open = async (url: string, width = 1400, height = 900) => {
    const page = await browser.open('about:blank', width, height);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: APP_PAGE });
    await page.goto(url);
    await page.waitFor('!!window.AibWindow && !!window.AgentWorkspaceUI && window.AibDesktop.available()', 15000, 'the app page');
    await page.waitFor('window.AgentWorkspaceUI._items().length === 2', 20000, 'both chats');
    return page;
  };
  return {
    s,
    dw,
    pk,
    base,
    popUrl,
    open,
    async close() {
      await browser.close();
      await s.close();
    },
  };
}

const storageKeys = (p: Page) => p.eval<string[]>('Object.keys(localStorage).sort()');
const shown = (p: Page, sel: string) =>
  p.eval<boolean>(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); return !!n && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0; })()`);
async function fresh(p: Page, n: number) {
  await p.eval('window.AgentNotifyUI.reportPresence(true), true');
  await p.waitFor(
    `(() => { const a = window.AibWindow.answer(); return !!a && a.windows.length === ${n}; })()`,
    8000,
    `an answer with ${n} windows`,
  );
}
const selectedKey = (p: Page) => p.eval<string>(`(document.querySelector('button.connection.selected') || { dataset: {} }).dataset.key || ''`);
const actionIds = (p: Page) =>
  p.eval<string[]>(`window.AgentCommands.buildActions(window.AgentSwitcherUI.makeCtx()).map((x) => x.id)`);
const runAction = (p: Page, id: string) =>
  p.eval<boolean>(`(() => { const a = window.AgentCommands.buildActions(window.AgentSwitcherUI.makeCtx()).find((x) => x.id === ${JSON.stringify(id)}); if (!a) return false; a.run(); return true; })()`);
const askOpen = (p: Page, target: Json) => p.eval<unknown>(`window.AgentNotifyUI.openFromDesktop(${JSON.stringify(target)})`);
async function until(f: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(100);
  }
}

Deno.test({
  ...OPTS,
  name: 'chat pop-out: opens its chat by the lasting key, hides the chrome, writes no layout, composer sends, keys off, K6 answers',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const made = await t.dw.open({ chat: { key: K1, project: t.pk, title: 'Checkout work' } }, 'm');
      assertEquals(made.w, 'w2');
      // a fresh profile: what the page keeps before the pop-out loads is nothing
      const pop = await t.open(t.popUrl('w2'), 480, 720);
      await pop.waitFor(`JSON.stringify(window.AgentWorkspaceUI.openKeys()) === ${JSON.stringify(JSON.stringify([K1]))}`, 15000, 'its chat open');
      await pop.waitFor(`document.getElementById('title').textContent.includes('Checkout work')`, 10000, 'its header');
      assertEquals(await pop.eval('document.body.classList.contains("aib-mode-chat")'), true);
      assertEquals(await pop.eval('window.AgentWorkspaceUI.popoutKey()'), K1);
      for (const sel of ['body > aside', '#chatTabs', '#subagentsPane', '#activityReveal']) {
        assertEquals(await shown(pop, sel), false, `${sel} hidden`);
      }
      for (const sel of ['#messages', '#prompt', '#send']) assertEquals(await shown(pop, sel), true, `${sel} shown`);
      const keysAfterLoad = await storageKeys(pop);

      // presence: kind chat + its chat
      let mine: Json | undefined;
      await until(() => !!(mine = t.s.ctx.presence.windows().find((x) => x.w === 'w2') as Json | undefined), 8000, 'presence');
      assertEquals(mine!.kind, 'chat');
      assertEquals(mine!.chat, K1);

      // the composer sends to its chat
      await pop.eval(`(() => { const p = document.getElementById('prompt'); p.value = 'from the pop-out'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await pop.click('#send');
      await until(() => t.s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === 'c1'), 8000, 'the prompt sent');

      // keys with no meaning here do nothing
      const key = (k: string, mods: Json) =>
        pop.eval(`document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${JSON.stringify(mods)}))), true`);
      await key('N', { ctrlKey: true, shiftKey: true });
      await key('p', { ctrlKey: true });
      await key('\\', { ctrlKey: true });
      await sleep(300);
      assertEquals(await pop.eval('window.AgentWorkspaceUI._draft()'), null, 'no new chat');
      assertEquals(await pop.eval('document.getElementById("wsProjMenu").hidden'), true, 'no project menu');
      assertEquals(await pop.eval('window.AgentWorkspaceUI.openKeys()'), [K1], 'still its chat');

      // no layout keys: nothing new beyond per-chat things, also after a resize
      await pop.viewport(420, 640);
      await sleep(600);
      const keys = await storageKeys(pop);
      const added = keys.filter((k) => !keysAfterLoad.includes(k));
      const layout = keys.filter((k) =>
        /^(studio-workspace|aib-workspace|studio-side-|aib-side|studio-right|aib-right|studio-split|aib-split|aib-files-tabs|studio-textsize|aib-textsize|studio-panel)/i.test(k)
      );
      assertEquals(layout, [], `layout keys written: ${keys.join(', ')}`);
      assert(added.every((k) => !/width|layout|tabs|split|panel/i.test(k)), `added after resize: ${added.join(', ')}`);

      // Ctrl+K offers no pop-out here (it is the pop-out)
      const ids = await actionIds(pop);
      assert(!ids.includes('chat:popout') && !ids.includes('doc:popout'), `actions: ${ids.join(', ')}`);

      // K6: a notification for its chat is this window's; another chat, a project or a doc is not
      assertEquals(await askOpen(pop, { type: 'chat', key: K1 }), 'mine');
      assertEquals(await askOpen(pop, { type: 'chat', key: K2 }), 'no');
      assertEquals(await askOpen(pop, { type: 'project', key: t.pk }), 'no');
      assertEquals(await askOpen(pop, { type: 'doc', project: t.pk, name: 'Release plan' }), 'no');
      await sleep(200);
      assertEquals(await pop.eval('window.AgentWorkspaceUI.openKeys()'), [K1], 'never replaced');
      // a chat link to another chat routes (op 'route'), never opens here
      const before = t.dw.delivered.length;
      await pop.eval(`window.AgentWorkspaceUI.routeOpen({ chat: ${JSON.stringify(K2)}, project: ${JSON.stringify(t.pk)} }, () => { window.__openedHere = true; }), true`);
      await until(() => t.dw.delivered.length > before, 5000, 'the route');
      assertEquals(t.dw.delivered.at(-1), ['m', { project: t.pk, chat: K2 }]);
      assertEquals(await pop.eval('!!window.__openedHere'), false);

      // its chat gone from the list (deleted): the pop-out closes its own window
      const other = `[{ provider: 'claude', sessionId: 'sess-2', id: 'c2', cwd: 'x' }]`;
      await pop.eval(`window.AgentWorkspaceUI.sync(${other}, null), window.AgentWorkspaceUI.sync(${other}, null), true`);
      await until(() => !t.dw.windows.some((x) => x.w === 'w2'), 8000, 'the pop-out closed itself');
      assertEquals(pop.errors, [], 'console errors');
      await pop.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'chat pop-out moves the chat: the tab closes, the row shows ↗ and brings it forward, closing it puts the tab back',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const a = await t.open(`${t.base}/?w=m`);
      await a.waitFor(`!!document.querySelector('button.connection[data-key="${K1}"]')`, 20000, 'the chat in the list');
      await a.click(`button.connection[data-key="${K1}"]`);
      await a.waitFor(`window.AgentWorkspaceUI.openKeys()[0] === ${JSON.stringify(K1)}`, 10000, 'chat 1 open');
      await a.click(`button.connection[data-key="${K2}"]`);
      await a.waitFor(`window.AgentWorkspaceUI.openKeys()[0] === ${JSON.stringify(K2)}`, 10000, 'chat 2 open');
      const tabs = () => a.eval<string[]>(`window.AgentWorkspaceUI._state().tabs[${JSON.stringify(t.pk)}] || []`);
      assertEquals(await tabs(), [K1, K2]);

      // the tab's right-click menu has Pop out
      await a.eval(`(() => {
        const tab = document.querySelector('.ws-tab[data-key="${K1}"]');
        const r = tab.getBoundingClientRect();
        tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
        return true;
      })()`);
      await a.waitFor(`[...document.querySelectorAll('#organizeMenu button')].some((b) => b.textContent === 'Pop out')`, 5000, 'Pop out in the menu');
      await a.eval(`[...document.querySelectorAll('#organizeMenu button')].find((b) => b.textContent === 'Pop out').click(), true`);
      await until(() => t.dw.windows.some((x) => x.kind === 'chat'), 8000, 'a chat window asked for');
      const win = t.dw.windows.find((x) => x.kind === 'chat')!;
      assertEquals([win.chat, win.project], [K1, t.pk], 'by the lasting key and its project');
      assert(win.url.includes('mode=chat') && win.url.includes('chat=claude%3Asess-1'), `its address: ${win.url}`);

      // the tab left; the active chat stayed
      await a.waitFor(`!(window.AgentWorkspaceUI._state().tabs[${JSON.stringify(t.pk)}] || []).includes(${JSON.stringify(K1)})`, 5000, 'the tab closed');
      assertEquals(await selectedKey(a), K2, 'the active chat stays');
      await a.waitFor(`!!document.querySelector('button.connection.popped[data-key="${K1}"] .ws-chatpop')`, 5000, 'the ↗ on the row');
      // the menu no longer offers Pop out for it
      assertEquals(await a.eval(`window.AgentWorkspaceUI.chatMenuItems({ provider: 'claude', sessionId: 'sess-1', id: 'c1' }).length`), 0);
      assertEquals(await a.eval(`window.AgentWorkspaceUI.chatMenuItems({ provider: 'claude', sessionId: 'sess-2', id: 'c2' }).length`), 1);

      // the pop-out loads and reports itself; the project window sees it
      const pop = await t.open(t.popUrl(win.w), 480, 720);
      await pop.waitFor(`window.AgentWorkspaceUI.openKeys()[0] === ${JSON.stringify(K1)}`, 15000, 'the pop-out shows its chat');
      await fresh(a, 2);
      await a.waitFor(`(() => { const p = window.AgentWorkspaceUI._pops()[0]; return !!p && p.seen && p.w === ${JSON.stringify(win.w)}; })()`, 10000, 'seen');
      // a notification for it is not this window's (the app then asks the pop-out)
      assertEquals(await askOpen(a, { type: 'chat', key: K1 }), 'no');
      assertEquals(await askOpen(pop, { type: 'chat', key: K1 }), 'mine');

      // clicking its row brings the pop-out forward; nothing opens here
      const focusedBefore = t.dw.focused.length;
      await a.click(`button.connection[data-key="${K1}"]`);
      await until(() => t.dw.focused.length > focusedBefore, 5000, 'a focus');
      assertEquals(t.dw.focused.at(-1), win.w, 'the pop-out came forward');
      await sleep(300);
      assertEquals(await selectedKey(a), K2, 'nothing opened here');

      // closing the pop-out (its pagehide): the tab comes back in the background
      await pop.goto('about:blank');
      await a.waitFor(`(window.AgentWorkspaceUI._state().tabs[${JSON.stringify(t.pk)}] || []).includes(${JSON.stringify(K1)})`, 10000, 'the tab is back');
      assertEquals(await selectedKey(a), K2, 'in the background');
      assertEquals(await a.eval('window.AgentWorkspaceUI._pops().length'), 0);
      await a.waitFor(`!document.querySelector('.ws-chatpop')`, 5000, 'the ↗ is gone');
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
  name: 'routed opens from the desktop app: a project switches the main window, a doc opens there, a project window says no to others',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const a = await t.open(`${t.base}/?w=m`);
      await a.waitFor(`window.AgentWorkspaceUI.paletteProjects().some((p) => p.key === ${JSON.stringify(t.pk)})`, 15000, 'the project');
      assertEquals(await askOpen(a, { type: 'project', key: t.pk }), 'mine');
      assertEquals(await a.eval('window.AgentWorkspaceUI.currentProject()'), t.pk);
      assertEquals(await askOpen(a, { type: 'project', key: 'w:c:/no/such/project' }), 'no', 'an unknown project');
      assertEquals(await askOpen(a, { type: 'doc', project: t.pk, name: 'release-plan' }), 'mine');
      await a.waitFor(`window.AgentFilesUI._state().tabs.tabs.some((x) => x.kind === 'doc')`, 10000, 'the doc tab');
      // Ctrl+K "Pop out this doc" (the doc on screen) and "Pop out this chat" are offered in the desktop app
      await a.waitFor(`!!window.AgentFilesUI.shownDocTab()`, 10000, 'the doc on screen');
      const ids = await actionIds(a);
      assert(ids.includes('doc:popout'), `actions: ${ids.join(', ')}`);
      assert(await runAction(a, 'doc:popout'));
      await until(() => t.dw.windows.some((x) => x.kind === 'doc'), 8000, 'a doc window asked for');
      assertEquals(t.dw.windows.find((x) => x.kind === 'doc')!.doc, { project: t.pk, name: 'release-plan' });
      await a.waitFor(`!window.AgentFilesUI._state().tabs.tabs.some((x) => x.kind === 'doc')`, 5000, 'the doc tab moved out');
      await a.click(`button.connection[data-key="${K1}"]`);
      await a.waitFor(`window.AgentWorkspaceUI.openKeys()[0] === ${JSON.stringify(K1)}`, 10000, 'chat 1 open');
      assert((await actionIds(a)).includes('chat:popout'), 'Pop out this chat offered');
      assert(await runAction(a, 'chat:popout'));
      await until(() => t.dw.windows.some((x) => x.kind === 'chat' && x.chat === K1), 8000, 'a chat window asked for');

      // a project window: its own project is 'mine', another project is not
      await t.dw.open({ project: { key: t.pk, name: 'proj', path: t.s.project } }, 'm');
      const pw = t.dw.windows.find((x) => x.kind === 'project')!;
      const b = await t.open(t.base + windowPath({ w: pw.w, kind: 'project', project: t.pk }));
      assertEquals(await askOpen(b, { type: 'project', key: t.pk }), 'mine');
      assertEquals(await askOpen(b, { type: 'project', key: 'w:c:/another' }), 'no');
      assertEquals(await askOpen(b, { type: 'doc', project: 'w:c:/another', name: 'x' }), 'no');
      assertEquals(a.errors, [], 'console errors');
      assertEquals(b.errors, [], 'console errors (project window)');
      await b.close();
      await a.close();
    } finally {
      await t.close();
    }
  },
});
