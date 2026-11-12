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
import { DesktopNotifications } from '../../outputs/agent-studio/server/desktop/notify.ts';
import { startAttention } from '../../outputs/agent-studio/server/attention/watcher.ts';

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
    s.web.native.set('POST /api/live/desktop/notify', (c, url, body, request) => {
      pagePosts++;
      return route(c, url, body, request);
    });
    const presence: Json[] = [];
    const report = s.ctx.presence.report.bind(s.ctx.presence);
    s.ctx.presence.report = (focused, idleMs) => {
      presence.push({ focused, idleMs });
      report(focused, idleMs);
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
      assertEquals(shown, [['Invoice parser', 'Needs you']], 'one desktop notification');
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
