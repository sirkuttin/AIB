/**
 * Multi-window Phase 1C (design section 4 K2/K5/K6, section 9, review D1–D3, A1): two chat.html pages in one headless Chrome
 * (one shared storage, as the app's windows share one profile), each its own AIB window by its ?w= id, against a Studio in this
 * process. The desktop app's page (its bridge function bound); nothing is shown on screen. Focus and visibility are set by the
 * test (window.__focus), so which window is "in front" is exact.
 *
 *   D1  only one window chimes: the sound owner (the window focused last), not every window in the background.
 *   D2  a chat open in window B is out of window A's inbox, badge, title and toasts.
 *   D3  routeOpen from A for a chat or project that B owns asks the server's route (K3 op 'route', the fake K4 delivers it to B)
 *       and does not open it in A; the inbox, a sidebar row and a project switch all go that way.
 *   K6  openFromDesktop in A answers 'no' for B's chat, 'mine' for its own.
 *   Single window: a lone page still chimes when away (today's behaviour) and reports its window id.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { remoteStudio } from './_remote_fixture.ts';
import { FakeDesktopWindows } from './_fake_desktop_windows.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The app page; focus and visibility under the test's control (headless tabs are otherwise all "focused" or none).
const APP_PAGE = [
  'window.bindings = { aibDesktop() {} };',
  'window.__focus = false;',
  'Document.prototype.hasFocus = function () { return !!window.__focus; };',
  "Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible' });",
  "Object.defineProperty(Document.prototype, 'hidden', { get: () => false });",
].join('\n');

async function lab() {
  const s = await remoteStudio();
  s.ctx.transcripts = {
    root: s.state,
    sessions: () => Promise.resolve([]),
    agents: () => Promise.resolve([]),
    sessionCwd: () => Promise.resolve(null),
  } as unknown as typeof s.ctx.transcripts;
  const chat = (n: number, title: string) => ({
    id: 'c' + n,
    provider: 'claude',
    sessionId: 'sess-' + n,
    cwd: s.root,
    busy: true,
    closed: false,
    attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() } as Json,
    subagents: {},
    breadth: { sessionInfo: { title } },
    events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }] as Json[],
    permissions: [] as Json[],
    elicitations: [],
  });
  s.chats.push(chat(1, 'Invoice parser'), chat(2, 'Release notes'));
  const needs = (n: number) => {
    const c = s.chats[n - 1];
    c.attention = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
    c.permissions = [{ key: 'k' + n, params: { toolCall: { title: 'Run npm test ' + n }, options: [] } }];
    c.events.push({ seq: c.events.length + 1, kind: 'permission', time: 2, data: { key: 'k' + n, params: {} } });
  };
  const browser = await Browser.launch();
  const open = async (query: string) => {
    const page = await browser.open('about:blank', 1280, 900);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: APP_PAGE });
    await page.goto(`http://127.0.0.1:${s.port}/${query}`);
    await page.waitFor('!!window.AibWindow && !!window.AgentNotifyUI && window.AibDesktop.available()', 15000, 'the app page');
    await page.waitFor('document.body.textContent.includes("Release notes")', 20000, 'the chats in the list');
    return page;
  };
  return {
    s,
    browser,
    open,
    needs,
    async close() {
      await browser.close();
      await s.close();
    },
  };
}

const projectKey = (p: Page) => p.eval<string>('window.AgentWorkspaceUI._items()[0].projectKey');
const chimes = (p: Page) => p.eval<number>('window.AgentNotifyUI._state.chimes');
const sawNeeds = (p: Page, key: string) =>
  p.waitFor(
    `(() => { const s = window.AgentNotifyUI._state; return !!s.prev && !!s.prev.conns[${JSON.stringify(key)}] && s.prev.conns[${
      JSON.stringify(key)
    }].needs > 0; })()`,
    20000,
    'the page saw ' + key + ' need you',
  );
/** Report now and wait until this page holds a fresh answer that lists `n` windows. */
async function fresh(p: Page, n: number) {
  await p.eval('window.AgentNotifyUI.reportPresence(true), true');
  await p.waitFor(
    `(() => { const a = window.AibWindow.answer(); return !!a && a.windows.length === ${n}; })()`,
    8000,
    `an answer with ${n} windows`,
  );
}

Deno.test({
  ...OPTS,
  name: 'multi-window D1: two windows in the background, only the sound owner (the one focused last) chimes',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const a = await t.open('?w=m');
      const pk = await projectKey(a);
      const b = await t.open(`?w=w2&kind=project&project=${encodeURIComponent(pk)}`);
      assertEquals(await a.eval('window.AibWindow.id()'), 'm');
      assertEquals(await b.eval('[window.AibWindow.id(), window.AibWindow.kind(), window.AibWindow.pinnedProject()]'), [
        'w2',
        'project',
        pk,
      ]);
      // B was used last: focused, then the owner went to another app
      await b.eval('window.__focus = true, window.AgentNotifyUI.reportPresence(true), true');
      await sleep(300);
      await b.eval('window.__focus = false, window.AgentNotifyUI.reportPresence(true), true');
      await fresh(a, 2);
      await fresh(b, 2);
      assertEquals(t.s.ctx.presence.soundOwner(), 'w2', 'the server names B the sound owner');
      assertEquals(await a.eval('window.AibWindow.soundMine()'), false);
      assertEquals(await b.eval('window.AibWindow.soundMine()'), true);
      // every presence report says which window it is (K2)
      assertEquals(t.s.ctx.presence.windows().map((w) => [w.w, w.kind, w.project]).sort(), [
        ['m', 'main', pk],
        ['w2', 'project', pk],
      ]);
      await sleep(2500); // both pages have seen the chats working (their baseline)
      t.needs(1);
      await sawNeeds(a, 'claude:sess-1');
      await sawNeeds(b, 'claude:sess-1');
      await sleep(500);
      assertEquals([await chimes(a), await chimes(b)], [0, 1], 'one chime in all, from B');
      assertEquals(a.errors, [], 'console errors A');
      assertEquals(b.errors, [], 'console errors B');
      // pagehide: B's slot goes at once (left: true), A is alone again and would chime
      await b.close();
      const end = Date.now() + 8000;
      while (t.s.ctx.presence.windows().some((w) => w.w === 'w2') && Date.now() < end) await sleep(100);
      assertEquals(t.s.ctx.presence.windows().map((w) => w.w), ['m'], 'the closed window left presence at once');
      await fresh(a, 1);
      assertEquals(await a.eval('window.AibWindow.soundMine()'), true, 'alone: A chimes again');
      await a.close();
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'multi-window D2: a chat open in window B is out of window A\'s inbox, badge, title and toasts; K6 answers',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    try {
      const a = await t.open('?w=m');
      const pk = await projectKey(a);
      const b = await t.open(`?w=w2&kind=project&project=${encodeURIComponent(pk)}`);
      await b.click('button.connection[data-key="claude:sess-1"]');
      await b.waitFor('JSON.stringify(window.AgentWorkspaceUI.openKeys()) === \'["claude:sess-1"]\'', 10000, 'B shows chat 1');
      await a.eval('window.__focus = true, true'); // A is in front: toasts, no sound
      await fresh(b, 2);
      await a.waitFor(
        '(() => { window.AgentNotifyUI.reportPresence(true); return window.AibWindow.othersOpen().join() === "claude:sess-1"; })()',
        10000,
        'A knows B shows chat 1',
      );
      assertEquals(await a.eval('window.AgentWorkspaceUI.openKeys()'), ['claude:sess-1'], 'in front of you: B\'s chat');
      await sleep(2500); // baseline
      t.needs(1);
      t.needs(2);
      await sawNeeds(a, 'claude:sess-1');
      await sawNeeds(a, 'claude:sess-2');
      await a.waitFor('!!document.querySelector(".ws-inbox-btn .ws-badge")', 10000, 'A\'s badge');
      await sleep(800);
      const seen = await a.eval<Json>(`(() => ({
        badge: document.querySelector('.ws-inbox-btn .ws-badge').textContent,
        title: document.title,
        inbox: window.AgentWorkspaceUI._inboxKeys(),
        toasts: Array.from(document.querySelectorAll('.toast-stack .toast')).map((n) => n.dataset.chat),
      }))()`);
      assertEquals(seen.badge, '1', 'only chat 2 counts in A');
      assert(String(seen.title).startsWith('(1) '), `A's title counts one: ${seen.title}`);
      assertEquals(seen.inbox, ['claude:sess-2'], 'B\'s chat is not in A\'s inbox');
      assertEquals(seen.toasts, ['claude:sess-2'], 'a toast for chat 2 only');
      // K6: a desktop notification for chat 1 is not A's (its project has its own window); chat 2 in B's project is not A's
      // either; the inbox target is
      assertEquals(await a.eval('window.AgentNotifyUI.openFromDesktop({ type: "chat", key: "claude:sess-1" })'), 'no');
      assertEquals(await a.eval('window.AgentNotifyUI.openFromDesktop({ type: "inbox" })'), 'mine');
      assertEquals(await b.eval('window.AgentNotifyUI.openFromDesktop({ type: "chat", key: "claude:sess-2" })'), 'mine');
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
  name: 'multi-window D3/A1: from window A, a chat or project that window B owns goes through the route and does not open in A',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    const dw = new FakeDesktopWindows();
    t.s.ctx.desktopWindows = dw;
    try {
      const a = await t.open('?w=m');
      const pk = await projectKey(a);
      await dw.open({ project: { key: pk, name: 'shop', path: t.s.root } }, 'm'); // the fake makes window w2 for the project
      const b = await t.open(`?w=w2&kind=project&project=${encodeURIComponent(pk)}`);
      await fresh(b, 2);
      await fresh(a, 2);
      const before = await a.eval<string[]>('window.AgentWorkspaceUI.openKeys()');
      // a sidebar row in A
      await a.click('button.connection[data-key="claude:sess-2"]');
      const end = Date.now() + 8000;
      while (!dw.delivered.length && Date.now() < end) await sleep(100);
      assertEquals(dw.delivered, [['w2', { chat: 'claude:sess-2', project: pk }]], 'the route delivered it to B');
      await sleep(500);
      assertEquals(await a.eval('window.AgentWorkspaceUI.openKeys()'), before, 'A did not open it');
      // the inbox's row in A
      t.needs(1);
      await sawNeeds(a, 'claude:sess-1');
      assertEquals(await a.eval('window.AgentNotifyUI._state.host.openChat("claude:sess-1")'), true, 'the toast path routes');
      const end2 = Date.now() + 8000;
      while (dw.delivered.length < 2 && Date.now() < end2) await sleep(100);
      assertEquals(dw.delivered[1], ['w2', { chat: 'claude:sess-1', project: pk }]);
      // a project switch (Ctrl+K's project pick, the dropdown) to B's project
      await a.eval(`window.AgentWorkspaceUI.selectProject(${JSON.stringify(pk)}), true`);
      const end3 = Date.now() + 8000;
      while (dw.delivered.length < 3 && Date.now() < end3) await sleep(100);
      assertEquals(dw.delivered[2], ['w2', { project: pk }]);
      await sleep(300);
      assertEquals(await a.eval('window.AgentWorkspaceUI.openKeys()'), before, 'A still shows what it showed');
      // B opens its own project's chat here, with no server call
      const routed = dw.delivered.length;
      await b.click('button.connection[data-key="claude:sess-2"]');
      await b.waitFor('JSON.stringify(window.AgentWorkspaceUI.openKeys()) === \'["claude:sess-2"]\'', 10000, 'B opens it');
      assertEquals(dw.delivered.length, routed, 'no route call for its own chat');
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
  name: 'multi-window: a single window behaves as today (it chimes when away, its chats open in it, no route call)',
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    const dw = new FakeDesktopWindows();
    t.s.ctx.desktopWindows = dw;
    try {
      const a = await t.open('');
      assertEquals(await a.eval('window.AibWindow.id()'), 'm', 'no query in the app: the main window (S6)');
      await fresh(a, 1);
      await sleep(2500);
      t.needs(1);
      await sawNeeds(a, 'claude:sess-1');
      await sleep(300);
      assertEquals(await chimes(a), 1, 'away and alone: it chimes');
      await a.click('button.connection[data-key="claude:sess-1"]');
      await a.waitFor('JSON.stringify(window.AgentWorkspaceUI.openKeys()) === \'["claude:sess-1"]\'', 10000, 'opened here');
      assertEquals(dw.delivered, [], 'no route call');
      assertEquals(a.errors, [], 'console errors');
      await a.close();
    } finally {
      await t.close();
    }
  },
});
