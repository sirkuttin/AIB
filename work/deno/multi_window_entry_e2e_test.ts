/**
 * Multi-window Phase 2B (design section 3 "entry points", K3, owner decision 1a): the page's ways to open a project in its own
 * window, headless chat.html pages against an AIB in this process with the fake K4 (_fake_desktop_windows.ts). Nothing is shown.
 *
 *   menu      the project menu's "Open in new window" sends K3 {op:'open', from, project:{key,name,path}}; a second time the
 *             project's window is brought forward (existed), no second window.
 *   Ctrl+K    "Open <project> in new window" sends the same body.
 *   Ctrl+click a project row in the dropdown sends the same body (a plain click does not).
 *   ↗         only on the project-list row of a project with its own window; clicking that row brings the window forward
 *             (K3 route, A does not switch); focusProjectWindow sends {op:'focus', w}.
 *   cap       at 8 windows (409) a quiet note says so and no window is made.
 *   serve     a browser page (no desktop app) offers none of them; a 501 {browser} says it needs the desktop app.
 *   one       a single window: no ↗ anywhere, a plain project click opens here with no window call.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { remoteAib } from './_remote_fixture.ts';
import { FakeDesktopWindows } from './_fake_desktop_windows.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Records every body the page posts to the windows route (window.__winCalls) and what came back.
const SPY = [
  'window.__winCalls = [];',
  'const __f = window.fetch.bind(window);',
  'window.fetch = async (u, o) => {',
  '  const r = await __f(u, o);',
  "  if (String(u).includes('/api/live/desktop/windows')) window.__winCalls.push({ body: JSON.parse(o.body), status: r.status });",
  '  return r;',
  '};',
].join('\n');
// The desktop app's page: its bridge function bound (AibDesktop.available()).
const APP = 'window.bindings = { aibDesktop() {} };\n' + SPY;

async function lab() {
  const s = await remoteAib();
  s.ctx.transcripts = {
    root: s.state,
    sessions: () => Promise.resolve([]),
    agents: () => Promise.resolve([]),
    sessionCwd: () => Promise.resolve(null),
  } as unknown as typeof s.ctx.transcripts;
  // a second project (its own folder), so a mark on one row and not the other is visible
  const other = await Deno.makeTempDir({ prefix: 'aib-mw2b-billing-' });
  const chat = (n: number, cwd: string, title: string) => ({
    id: 'c' + n,
    provider: 'claude',
    sessionId: 'sess-' + n,
    cwd,
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null } as Json,
    subagents: {},
    breadth: { sessionInfo: { title } },
    events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }] as Json[],
    permissions: [] as Json[],
    elicitations: [],
  });
  s.chats.push(chat(1, s.root, 'Invoice parser'), chat(2, other, 'Billing export'));
  const browser = await Browser.launch();
  const open = async (query: string, app = true) => {
    const page = await browser.open('about:blank', 1280, 900);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: app ? APP : SPY });
    await page.goto(`http://127.0.0.1:${s.port}/${query}`);
    await page.waitFor('!!window.AibWindow && !!window.AgentWorkspaceUI && !!window.AgentNotifyUI', 15000, 'the page');
    await page.waitFor('window.AgentWorkspaceUI._items().length === 2', 20000, 'both chats');
    return page;
  };
  return {
    s,
    open,
    async close() {
      await browser.close();
      await s.close();
      await Deno.remove(other, { recursive: true }).catch(() => {});
    },
  };
}

const projectKey = (p: Page) => p.eval<string>('window.AgentWorkspaceUI._items().find((i) => i.key === "claude:sess-1").projectKey');
const calls = (p: Page) => p.eval<{ body: Json; status: number }[]>('window.__winCalls');
async function waitCalls(p: Page, n: number) {
  await p.waitFor(`window.__winCalls.length >= ${n}`, 8000, `${n} window call(s)`);
  await sleep(150);
  return calls(p);
}
/** Report now and wait until this page holds a fresh answer that lists `n` windows. */
async function fresh(p: Page, n: number) {
  await p.eval('window.AgentNotifyUI.reportPresence(true), true');
  await p.waitFor(
    `(() => { const a = window.AibWindow.answer(); return !!a && a.windows.length === ${n}; })()`,
    8000,
    `an answer with ${n} windows`,
  );
}
const menuItems = (p: Page, pk: string) =>
  p.eval<string[]>(`(() => {
    window.AgentWorkspaceUI.openProjectCtx(${JSON.stringify(pk)}, 200, 200);
    const m = document.querySelector('.ws-menu[role=menu]');
    const out = m ? Array.from(m.querySelectorAll('.ws-menu-item')).map((b) => b.textContent) : [];
    if (m) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return out;
  })()`);
const clickMenuItem = (p: Page, pk: string, label: string) =>
  p.eval<boolean>(`(() => {
    window.AgentWorkspaceUI.openProjectCtx(${JSON.stringify(pk)}, 200, 200);
    const b = Array.from(document.querySelectorAll('.ws-menu[role=menu] .ws-menu-item')).find((x) => x.textContent === ${
    JSON.stringify(label)
  });
    if (!b) return false;
    b.click();
    return true;
  })()`);
// A click on the dropdown's row for project pk (ctrl: Ctrl held).
const clickProjectRow = (p: Page, pk: string, ctrl: boolean) =>
  p.eval<boolean>(`(() => {
    window.AgentWorkspaceUI.openProjectMenu();
    const row = document.querySelector('.ws-prow[data-project=' + JSON.stringify(${JSON.stringify(pk)}) + '] .ws-prow-main');
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: ${ctrl}, clientX: 120, clientY: 120 }));
    return true;
  })()`);

Deno.test({
  ...OPTS,
  name: 'multi-window 2B: the project menu, Ctrl+K and Ctrl+click send op open; a project with a window is brought forward',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    const dw = new FakeDesktopWindows();
    t.s.ctx.desktopWindows = dw;
    try {
      const a = await t.open('?w=m');
      const pk = await projectKey(a);
      const name = await a.eval<string>(
        `window.AgentWorkspaceUI.paletteProjects().find((p) => p.key === ${JSON.stringify(pk)}).name`,
      );
      const want = { op: 'open', from: 'm', project: { key: pk, name, path: t.s.root } };
      // the menu
      assert((await menuItems(a, pk)).includes('Open in new window'), 'the menu offers it');
      assert(await clickMenuItem(a, pk, 'Open in new window'), 'clicked the menu item');
      let c = await waitCalls(a, 1);
      assertEquals(c[0], { body: want, status: 200 });
      assertEquals(dw.made, 1, 'one project window');
      assertEquals(dw.windows.map((w) => [w.w, w.kind, w.project]), [['m', 'main', null], ['w2', 'project', pk]]);
      assertEquals(await a.eval('!!document.querySelector(".ws-menu[role=menu]")'), false, 'the menu closed');
      // again: the project's window comes forward, no second window (D1a)
      await a.eval('window.__winCalls.length = 0, true');
      const focusedBefore = dw.focused.length;
      assert(await clickMenuItem(a, pk, 'Open in new window'));
      c = await waitCalls(a, 1);
      assertEquals(c[0].body, want);
      assertEquals(dw.made, 1, 'still one project window');
      assertEquals(dw.focused.slice(focusedBefore), ['w2'], 'brought forward');
      // Ctrl+K "Open <project> in new window"
      await a.eval('window.__winCalls.length = 0, true');
      const ran = await a.eval<string>(`(() => {
        const ctx = window.AgentSwitcherUI.makeCtx();
        const act = window.AgentCommands.buildActions(ctx).find((x) => x.id === 'new-window:' + ${JSON.stringify(pk)});
        if (!act) return '';
        act.run();
        return act.title;
      })()`);
      assertEquals(ran, `Open ${name} in new window`);
      c = await waitCalls(a, 1);
      assertEquals(c[0].body, want);
      // Ctrl+click on the dropdown's project row; a plain click does not call the windows route
      await a.eval('window.__winCalls.length = 0, true');
      assert(await clickProjectRow(a, pk, true), 'the dropdown row');
      c = await waitCalls(a, 1);
      assertEquals(c[0].body, want);
      assertEquals(dw.made, 1, 'every entry point found the one window');
      assertEquals(a.errors, [], 'console errors');
      await a.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'multi-window 2B: ↗ only on a project that has its own window; its row brings that window forward; not offered there',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    const dw = new FakeDesktopWindows();
    t.s.ctx.desktopWindows = dw;
    try {
      const a = await t.open('?w=m');
      const pk = await projectKey(a);
      await fresh(a, 1);
      assertEquals(await a.eval('document.querySelectorAll(".ws-prow-win").length'), 0, 'one window: no mark');
      await dw.open({ project: { key: pk, name: 'shop', path: t.s.root } }, 'm');
      const b = await t.open(`?w=w2&kind=project&project=${encodeURIComponent(pk)}`);
      await fresh(b, 2);
      await fresh(a, 2);
      const marks = () =>
        a.eval<string[]>(`(() => {
          window.AgentWorkspaceUI.openProjectMenu();
          return Array.from(document.querySelectorAll('.ws-prow')).filter((r) => r.querySelector('.ws-prow-win'))
            .map((r) => r.dataset.project + ' ' + r.querySelector('.ws-prow-win').textContent);
        })()`);
      await a.waitFor(
        `(() => { window.AgentWorkspaceUI.openProjectMenu(); return !!document.querySelector('.ws-prow .ws-prow-win'); })()`,
        8000,
        'the ↗ on its row',
      );
      assertEquals(await marks(), [pk + ' ↗'], 'only the project with its own window');
      // clicking that row brings its window forward (through the route; nothing opens here)
      const focusedBefore = dw.focused.length;
      const activeBefore = await a.eval<string>('window.AgentWorkspaceUI._state().active');
      assert(await clickProjectRow(a, pk, false));
      const c = await waitCalls(a, 1);
      assertEquals(c[0], { body: { op: 'route', from: 'm', target: { project: pk } }, status: 200 });
      assertEquals(dw.focused.slice(focusedBefore), ['w2']);
      assertEquals(await a.eval('window.AgentWorkspaceUI._state().active'), activeBefore, 'A did not switch project');
      // the mark's own route (K3 op focus)
      await a.eval('window.__winCalls.length = 0, true');
      assertEquals(await a.eval(`window.AgentWorkspaceUI.focusProjectWindow(${JSON.stringify(pk)})`), true);
      assertEquals((await waitCalls(a, 1))[0], { body: { op: 'focus', w: 'w2' }, status: 200 });
      // the project window itself: no ↗ for its own project, and no "Open in new window" for it
      assertEquals(await b.eval('document.querySelectorAll(".ws-prow-win").length'), 0);
      assert(!(await menuItems(b, pk)).includes('Open in new window'), 'not offered in its own window');
      assertEquals(a.errors, [], 'console errors A');
      assertEquals(b.errors, [], 'console errors B');
      await a.close();
      await b.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'multi-window 2B: at the cap (409) a quiet note, no window made',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    const dw = new FakeDesktopWindows();
    t.s.ctx.desktopWindows = dw;
    try {
      const a = await t.open('?w=m');
      const pk = await projectKey(a);
      for (let n = 2; n <= 8; n++) await dw.open({ project: { key: 'other-' + n, name: 'p' + n, path: t.s.root + n } }, 'm');
      const made = dw.made;
      assert(await clickMenuItem(a, pk, 'Open in new window'));
      const c = await waitCalls(a, 1);
      assertEquals(c[0].status, 409);
      assertEquals(dw.made, made, 'no window made');
      const note = await a.eval<Json>(`(() => {
        const n = document.querySelector('.ws-window-note');
        return n ? { text: n.textContent, role: n.getAttribute('role') } : {};
      })()`);
      assert(String(note.text).includes('8 windows'), `the note: ${note.text}`);
      assertEquals(note.role, 'status');
      assertEquals(await a.eval('document.getElementById("error").hidden'), true, 'not the error banner');
      assertEquals(a.errors, [], 'console errors');
      await a.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'multi-window 2B: serve (browser) offers no entry point; a 501 from the server says it needs the desktop app',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      // a browser tab: no desktop app
      const a = await t.open('', false);
      const pk = await projectKey(a);
      assert(!(await menuItems(a, pk)).includes('Open in new window'), 'no menu item');
      assertEquals(
        await a.eval(
          `window.AgentCommands.buildActions(window.AgentSwitcherUI.makeCtx()).filter((x) => x.id.startsWith('new-window:')).length`,
        ),
        0,
        'no Ctrl+K action',
      );
      assert(await clickProjectRow(a, pk, true), 'Ctrl+click the row');
      await a.waitFor(`window.AgentWorkspaceUI._state().active === ${JSON.stringify(pk)}`, 8000, 'it just opened here');
      assertEquals(await calls(a), [], 'no window call');
      assertEquals(a.errors, [], 'console errors A');
      await a.close();
      // the app page, but the server has no desktop windows (ctx.desktopWindows null): 501 {browser}
      const b = await t.open('?w=m');
      assert(await clickMenuItem(b, pk, 'Open in new window'));
      const c = await waitCalls(b, 1);
      assertEquals(c[0].status, 501);
      await b.waitFor('!!document.querySelector(".ws-window-note")', 5000, 'the note');
      assert(String(await b.eval('document.querySelector(".ws-window-note").textContent')).includes('desktop app'));
      assertEquals(b.errors, [], 'console errors B');
      await b.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'multi-window 2B: one window looks and behaves as before (no mark, a plain click opens here, no window call)',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    const dw = new FakeDesktopWindows();
    t.s.ctx.desktopWindows = dw;
    try {
      const a = await t.open('');
      const pk = await projectKey(a);
      await fresh(a, 1);
      const rows = await a.eval<string[]>(`(() => {
        window.AgentWorkspaceUI.openProjectMenu();
        return Array.from(document.querySelectorAll('.ws-prow')).map((r) => r.textContent);
      })()`);
      assertEquals(rows.length, 2, 'both projects listed');
      assert(rows.every((r) => !r.includes('↗')), `no mark: ${rows}`);
      assertEquals(await a.eval('document.querySelectorAll(".ws-prow-win").length'), 0);
      assert(await clickProjectRow(a, pk, false), 'plain click on the row');
      await a.waitFor(`window.AgentWorkspaceUI._state().active === ${JSON.stringify(pk)}`, 8000, 'opened here');
      assertEquals(await a.eval('document.querySelectorAll(".ws-prow-win, .ws-window-note").length'), 0);
      await sleep(300);
      assertEquals(await calls(a), [], 'no window call');
      assertEquals(dw.made, 0);
      assertEquals(a.errors, [], 'console errors');
      await a.close();
    } finally {
      await t.close();
    }
  },
});
