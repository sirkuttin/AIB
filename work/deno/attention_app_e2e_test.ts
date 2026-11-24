/**
 * Desktop notifications in the app come from the server's AttentionWatcher, never also from the page (phase C): chat.html runs in a
 * headless Chrome as the desktop app's page (the app's bridge function bound, the window not in front), with a Studio in this
 * process whose desktop notifications go to a test notifier (nothing is shown on the screen). A chat that comes to need you gives
 * exactly one desktop notification, and the page never posts /api/live/desktop/notify; the page still reports whether AIB is in
 * front (POST /api/live/presence).
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { remoteStudio } from './_remote_fixture.ts';
import { DesktopNotifications } from '../../app/server/desktop/notify.ts';
import { startAttention } from '../../app/server/attention/watcher.ts';
import { blockedCount } from '../../app/server/attention/inbox_rules.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  ...OPTS,
  name: 'desktop app: a chat that needs you gives one desktop notification (the server); the page sends none of its own',
  ignore: !browserPath,
  async fn() {
    const s = await remoteStudio();
    // no saved transcripts in this data folder (the page's /api/sessions)
    s.ctx.transcripts = {
      root: s.state,
      sessions: () => Promise.resolve([]),
      agents: () => Promise.resolve([]),
      sessionCwd: () => Promise.resolve(null),
    } as unknown as typeof s.ctx.transcripts;
    const shown: [string, string][] = [];
    // the test notifier: what the app process would show (Windows balloon, osascript, notify-send), recorded instead
    s.ctx.desktopNotify = new DesktopNotifications(
      { mechanism: 'test', show: (title, body) => (shown.push([title, body]), Promise.resolve({ shown: true })) },
      () => {},
    );
    let pagePosts = 0;
    const route = s.web.native.get('POST /api/live/desktop/notify')!;
    s.web.native.set('POST /api/live/desktop/notify', (c, url, body, request, principal) => {
      pagePosts++;
      return route(c, url, body, request, principal);
    });
    const presence: Json[] = [];
    // every report, with or without a window id (K2: the page now says which window it is)
    const report = s.ctx.presence.reportWindow.bind(s.ctx.presence);
    s.ctx.presence.reportWindow = (body) => {
      const b = (body ?? {}) as Json;
      presence.push({ w: b.w, focused: b.focused, idleMs: b.idleMs });
      return report(body);
    };
    s.chats.push({
      id: 'c1',
      provider: 'claude',
      sessionId: 'sess-1',
      cwd: s.root,
      busy: true,
      closed: false,
      attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() },
      subagents: {},
      breadth: { sessionInfo: { title: 'Invoice parser' } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'parse the invoices' } }],
      permissions: [],
      elicitations: [],
    });
    const watcher = startAttention(s.ctx, { pollMs: 200 });
    const browser = await Browser.launch();
    try {
      const page = await browser.open('about:blank', 1280, 900);
      // the desktop app's page: its bridge function is bound (desktop-bridge.js available()), and AIB is not in front
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.bindings = { aibDesktop() {} }; Document.prototype.hasFocus = () => false;',
      });
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!window.AgentNotifyUI && window.AibDesktop && window.AibDesktop.available()', 15000, 'the app page');
      await page.waitFor('document.body.textContent.includes("Invoice parser")', 20000, 'the chat in the list');
      await sleep(2500); // the page has seen the chat working (its baseline)
      s.chats[0].attention = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
      s.chats[0].permissions = [{ key: 'k1', params: { toolCall: { title: 'Run npm test' }, options: [] } }];
      s.chats[0].events.push({ seq: 2, kind: 'permission', time: 2, data: { key: 'k1', params: {} } });
      const deadline = Date.now() + 15_000;
      while (!shown.length && Date.now() < deadline) await sleep(100);
      // the page sees it too (its inbox, badge and sound): give it several list refreshes
      await page.waitFor(
        '(() => { const s = window.AgentNotifyUI._state; return !!s.prev && Object.values(s.prev.conns).some((c) => c.needs > 0); })()',
        20000,
        'the page saw the chat need you',
      );
      await sleep(3000);
      // one desktop notification: the chat, then "<project> · <the request>" (inbox v3)
      assertEquals(shown.length, 1, 'one desktop notification');
      assertEquals(shown[0][0], 'Invoice parser');
      assert(String(shown[0][1]).endsWith('\u00b7 Run npm test'), `project · the request: ${shown[0][1]}`);
      assertEquals(pagePosts, 0, 'the page posted no notification of its own');
      assert(presence.some((p) => p.focused === false), `the page reports AIB is not in front: ${JSON.stringify(presence)}`);
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await watcher.stop();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'desktop app: the chat open in the window (not focused) is left out of the inbox, badge, title, tray count and desktop ' +
    'notifications; switching to another chat brings it back',
  ignore: !browserPath,
  async fn() {
    const s = await remoteStudio();
    s.ctx.transcripts = {
      root: s.state,
      sessions: () => Promise.resolve([]),
      agents: () => Promise.resolve([]),
      sessionCwd: () => Promise.resolve(null),
    } as unknown as typeof s.ctx.transcripts;
    const shown: [string, string][] = [];
    s.ctx.desktopNotify = new DesktopNotifications(
      { mechanism: 'test', show: (title, body) => (shown.push([title, body]), Promise.resolve({ shown: true })) },
      () => {},
    );
    const chat = (n: number, title: string) => ({
      id: 'c' + n,
      provider: 'claude',
      sessionId: 'sess-' + n,
      cwd: s.root,
      busy: true,
      closed: false,
      attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() },
      subagents: {},
      breadth: { sessionInfo: { title } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }],
      permissions: [] as Json[],
      elicitations: [],
    });
    s.chats.push(chat(1, 'Invoice parser'), chat(2, 'Release notes'));
    // the tray's count (main.ts trayCounts): the inbox's one number without the chats open in the window
    const trayCount = () => blockedCount(s.chats as never, {}, Date.now() / 1000, s.ctx.presence.openOnPc());
    const watcher = startAttention(s.ctx, { pollMs: 200 });
    const browser = await Browser.launch();
    try {
      const page = await browser.open('about:blank', 1280, 900);
      // the desktop app's page; the window is visible but not focused (the owner reads another app)
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.bindings = { aibDesktop() {} }; Document.prototype.hasFocus = () => false;',
      });
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!window.AgentNotifyUI && window.AibDesktop && window.AibDesktop.available()', 15000, 'the app page');
      await page.waitFor('document.body.textContent.includes("Release notes")', 20000, 'the chats in the list');
      await page.click('button.connection[data-key="claude:sess-1"]');
      await page.waitFor(
        'JSON.stringify(window.AgentWorkspaceUI.openKeys()) === \'["claude:sess-1"]\'',
        10000,
        'Invoice parser open',
      );
      const deadline0 = Date.now() + 10_000;
      while (s.ctx.presence.openOnPc().join() !== 'claude:sess-1' && Date.now() < deadline0) await sleep(100);
      assertEquals(s.ctx.presence.openOnPc(), ['claude:sess-1'], 'the page tells the server which chat is open');
      assertEquals(s.ctx.presence.focused(), false, 'the window has no focus');
      await sleep(2500); // the page and the watcher have seen both chats working
      // the open chat comes to need you
      s.chats[0].attention = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
      s.chats[0].permissions = [{ key: 'k1', params: { toolCall: { title: 'Run npm test' }, options: [] } }];
      s.chats[0].events.push({ seq: 2, kind: 'permission', time: 2, data: { key: 'k1', params: {} } });
      await page.waitFor(
        '(() => { const s = window.AgentNotifyUI._state; return !!s.prev && Object.values(s.prev.conns).some((c) => c.needs > 0); })()',
        20000,
        'the page saw the chat need you',
      );
      await sleep(3000);
      assertEquals(shown, [], 'no desktop notification for the chat open in the window');
      assertEquals(await page.eval('!!document.querySelector(".ws-inbox-btn .ws-badge")'), false, 'no inbox badge');
      assert(!(await page.eval<string>('document.title')).startsWith('('), 'no count in the window title');
      assertEquals(trayCount(), 0, 'not in the tray count or the taskbar dot');
      // switched to the other chat: the waiting one is in the inbox again (badge, title, tray)
      await page.click('button.connection[data-key="claude:sess-2"]');
      await page.waitFor('!!document.querySelector(".ws-inbox-btn .ws-badge")', 10000, 'the badge is back');
      assertEquals(await page.eval<string>('document.querySelector(".ws-inbox-btn .ws-badge").textContent'), '1');
      await page.waitFor('document.title.startsWith("(1) ")', 10000, 'the title counts it again');
      const deadline1 = Date.now() + 10_000;
      while (s.ctx.presence.openOnPc().join() !== 'claude:sess-2' && Date.now() < deadline1) await sleep(100);
      assertEquals(trayCount(), 1, 'the tray counts it again');
      // a request of the other (now open) chat: no desktop notification either; the first one still none
      s.chats[1].attention = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
      s.chats[1].permissions = [{ key: 'k2', params: { toolCall: { title: 'Run deno task build' }, options: [] } }];
      s.chats[1].events.push({ seq: 2, kind: 'permission', time: 2, data: { key: 'k2', params: {} } });
      await sleep(3000);
      assertEquals(shown, []);
      assertEquals(trayCount(), 1);
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await watcher.stop();
      await s.close();
    }
  },
});
