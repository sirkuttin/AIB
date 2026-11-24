/**
 * Inbox v3.1 phase 1: ONE server builder (attention/inbox.ts, inbox-rules.js rowsOf) makes the inbox's rows and count, and every
 * surface draws them. In a headless Chrome (no window), against an in-process AIB with a fake agent host and a paired phone:
 *  - GET /api/live/inbox answers the rows (an approval, a question in a reply, a failed turn, a finished turn), the count and the
 *    working line; ?since=<version> answers 204 while nothing changed;
 *  - the PC's inbox draws those rows (marked as server rows), in the server's order, with the server's line 1;
 *  - the phone's inbox draws the same rows in the same order with the same line 1 (no "Needs you in <project>" split);
 *  - the PC badge = the phone badge = the route's count = the phone home's `waiting` = the trays' count.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { liveChat, v2Aib } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const ONCE = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ASK =
  'I went through the branch, ran the targeted tests and read the logs. The build passes and the notes are updated in the docs ' +
  'folder.\n\nShould I merge the release branch now, or wait for the full suite?';

Deno.test({
  ...OPTS,
  name: 'inbox v3.1 phase 1: the PC and the phone draw the same server-built rows, and every count agrees',
  ignore: !browserPath,
  async fn() {
    const s = await v2Aib();
    const browser = await Browser.launch();
    try {
      s.chats.push(
        liveChat('c-appr', s.project, {
          breadth: { sessionInfo: { title: 'Checkout fix' } },
          attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null },
          permissions: [{ key: 'p1', params: { toolCall: { title: 'Bash', rawInput: { command: 'npm install stripe@18.0.0' } }, options: ONCE } }],
        }),
        liveChat('c-fail', s.project, {
          breadth: { sessionInfo: { title: 'PDF totals' } },
          attention: { state: 'idle', needs: 0, turnEndedAt: ago(20), busySince: null, failedAt: ago(20), error: 'Usage limit reached. It resets at 3:40 PM.' },
        }),
        liveChat('c-asks', s.project, {
          breadth: { sessionInfo: { title: 'Release' } },
          attention: { state: 'idle', needs: 0, turnEndedAt: ago(9), busySince: null, asksAt: ago(9), question: 'Should I merge the release branch now, or wait for the full suite?' },
          events: [
            { seq: 1, kind: 'user', time: Date.now() / 1000 - 700, data: { text: 'Ship it' } },
            { seq: 2, kind: 'update', time: Date.now() / 1000 - 600, data: { sessionId: 'sess-c-asks', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ASK } } } },
          ],
        }),
        liveChat('c-done', s.project, {
          breadth: { sessionInfo: { title: 'Docs page' } },
          attention: { state: 'idle', needs: 0, turnEndedAt: ago(3), busySince: null },
          events: [
            { seq: 1, kind: 'user', time: Date.now() / 1000 - 300, data: { text: 'Rebuild the docs' } },
            { seq: 2, kind: 'update', time: Date.now() / 1000 - 200, data: { sessionId: 'sess-c-done', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Docs page rebuilt; all links checked.' } } } },
          ],
        }),
        liveChat('c-work', s.project, { busy: true, attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: ago(1) } }),
      );
      await s.ctx.conversations.apply('your_turn', 'claude', 'sess-c-done');

      // the route
      const [status, inbox] = await pc(s, 'GET', '/api/live/inbox');
      assertEquals(status, 200);
      const rows = inbox.rows as Json[];
      const order = rows.map((r) => r.key);
      assertEquals(order, ['claude:sess-c-fail', 'claude:sess-c-asks', 'claude:sess-c-appr', 'claude:sess-c-done'], JSON.stringify(rows.map((r) => [r.key, r.since])));
      assertEquals(rows.map((r) => r.kind), ['failed', 'asks', 'approval', 'finished']);
      assertEquals(rows.map((r) => r.section), ['needs', 'needs', 'needs', 'review']);
      assertEquals(rows[2].what, 'Run npm install stripe@18.0.0');
      assertEquals(rows[3].what, 'Docs page rebuilt; all links checked.');
      assertEquals(inbox.count, 3);
      assertEquals(inbox.working, { chats: 1, projects: 1 });
      const again = await fetch(`http://127.0.0.1:${s.port}/api/live/inbox?since=${inbox.version}`, { headers: { 'X-Studio-Token': s.token } });
      assertEquals(again.status, 204, 'nothing changed: 204');
      await again.body?.cancel();

      // the PC's inbox draws exactly those rows
      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!window.AgentWorkspaceUI && !!document.querySelector(".ws-inbox-btn .ws-badge")', 20000, 'the badge');
      await page.click('.ws-inbox-btn');
      await page.waitFor('document.querySelectorAll("#wsInbox .ws-inbox-item[data-src=server]").length === 4', 10000, 'the server rows on the PC');
      const pcView = await page.eval<Json>(`(() => {
        const items = [...document.querySelectorAll('#wsInbox .ws-inbox-item')];
        return { keys: items.map((n) => n.dataset.key), what: items.map((n) => n.querySelector('.ws-inbox-what').textContent),
          badge: document.querySelector('.ws-inbox-btn .ws-badge').textContent, foot: document.querySelector('#wsInbox .ws-inbox-foot').textContent };
      })()`);
      assertEquals(pcView.keys, order, 'the PC shows the server order');
      assertEquals(pcView.what, rows.map((r) => r.what), 'the PC shows the server line 1');
      assertEquals(pcView.badge, '3');
      assert(String(pcView.foot).startsWith('Working: 1 chat'), String(pcView.foot));
      assertEquals(page.errors, [], 'PC console errors');

      // the phone draws the same rows, same order, same words
      const phone = await pairPhone(s);
      const ph = await phonePage(browser, s, phone);
      await ph.waitFor('document.querySelector("#phInbox .ph-env-badge")?.textContent === "3"', 15000, 'the phone badge');
      await tap(ph, '#phInbox');
      await ph.waitFor('document.querySelectorAll(".ph-icard").length === 4', 8000, 'the phone cards');
      const phView = await ph.eval<Json>(`(() => {
        const cards = [...document.querySelectorAll('.ph-icard')];
        return { keys: cards.map((c) => c.dataset.key), what: cards.map((c) => c.querySelector('.ph-iwhat').textContent),
          heads: [...document.querySelectorAll('.ph-ih')].map((h) => h.textContent) };
      })()`);
      assertEquals(phView.keys, order, 'the phone shows the server order');
      assertEquals(phView.what, rows.map((r) => r.what), 'the phone shows the server line 1');
      assertEquals(phView.heads, ['Needs you', 'To review']);

      // every count agrees: the phone home's waiting and the trays' count too
      const [, home] = await pc(s, 'GET', '/api/live/inbox');
      assertEquals(home.count, 3);
      assertEquals(s.ctx.inbox.desktopCount(), 3, 'the trays');
      const homePayload = (await import('../../app/server/remote/payloads.ts')).homePayload;
      const h = await homePayload(s.ctx, 'pc', s.ctx.phone.titles);
      assertEquals(h.waiting, 3, 'the phone home');
      assertEquals((h.inbox as unknown as Json).count, 3);
      await page.close();
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
