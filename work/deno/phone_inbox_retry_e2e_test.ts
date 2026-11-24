/**
 * Retry on the phone's inbox (0.12.1): a failed chat's card has Retry, as the PC inbox and a Windows notification do. It is the
 * server's inbox action (attention/inbox_act.ts `retry`: your last message to the chat sent again as a new turn, text only) through
 * the phone's chat-op route, behind the phone's Send switch (phone.prompt) and in the phone activity log like the other actions.
 * One row of actions, each at least 44 px tall.
 *
 * An in-process AIB with a fake agent host and a headless Chrome (no window) for the phone page at 375 px.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { liveChat, phoneCall, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { lastUserText } from '../../app/server/attention/inbox_act.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const CARD = '.ph-icard[data-kind=failed]';

Deno.test('lastUserText: the last message of yours in this session, text only', () => {
  const state = {
    events: [
      { kind: 'user', data: { text: 'first', sessionId: 's1' } },
      { kind: 'user', data: { text: 'mine', sessionId: 's2' } },
      { kind: 'update', data: {} },
      { kind: 'user', data: { text: '   ', sessionId: 's2' } },
      { kind: 'user', data: { text: 'old session', sessionId: 's1' } },
    ],
  };
  assertEquals(lastUserText(state, 's2'), 'mine');
  assertEquals(lastUserText(state), 'old session');
  assertEquals(lastUserText(null), '');
});

Deno.test({
  ...OPTS,
  name: 'phone inbox: a failed chat has Retry (one row, 44 px); Retry sends your last message again; without Send it is refused',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      const failed = liveChat('c-fail', s.project, {
        breadth: { sessionInfo: { title: 'Coupon field' } },
        attention: { state: 'idle', needs: 0, turnEndedAt: ago(3), busySince: null, failedAt: ago(2), error: 'Rate limit reached' },
        events: [
          { seq: 1, kind: 'user', time: Date.now() / 1000 - 600, data: { text: 'Fix the checkout', sessionId: 'sess-c-fail' } },
          { seq: 2, kind: 'user', time: Date.now() / 1000 - 300, data: { text: 'Add the coupon field', sessionId: 'sess-c-fail' } },
        ],
      });
      s.chats.push(failed);
      const prompts: Json[] = [];
      s.answerLive((name, body) => {
        if (name === 'prompt') {
          prompts.push(body);
          failed.busy = true;
          failed.attention = { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() };
        }
        return [200, { ok: true, accepted: true }];
      });
      const [, inbox] = await pc(s, 'GET', '/api/live/inbox?fresh=1');
      assertEquals((inbox.rows as Json[]).map((r) => r.kind), ['failed'], JSON.stringify(inbox));

      // the phone: Retry · Reply · snooze, one row, each 44 px or more, no sideways scroll
      const phone = await pairPhone(s);
      const ph = await phonePage(browser, s, phone);
      await tap(ph, '#phInbox');
      await ph.waitFor(`!!document.querySelector(${JSON.stringify(CARD)})`, 10000, 'the failed card');
      const shape = await ph.eval<Json>(`(() => {
        const bs = [...document.querySelectorAll(${JSON.stringify(CARD + ' .ph-iacts button')})];
        const r = bs.map((b) => b.getBoundingClientRect());
        return { acts: bs.map((b) => b.dataset.act), words: bs.map((b) => b.textContent), heights: r.map((x) => Math.round(x.height)),
          widths: r.map((x) => Math.round(x.width)), tops: [...new Set(r.map((x) => Math.round(x.top)))].length,
          wide: document.documentElement.scrollWidth - innerWidth };
      })()`);
      assertEquals(shape.acts, ['retry', 'reply', 'snooze']);
      assertEquals((shape.words as string[]).slice(0, 2), ['Retry', 'Reply']);
      for (const h of shape.heights as number[]) assert(h >= 44, `tap height ${shape.heights}`);
      for (const w of shape.widths as number[]) assert(w >= 44, `tap width ${shape.widths}`);
      assertEquals(shape.tops, 1, 'one row of actions');
      assert(Number(shape.wide) <= 0, `sideways scroll ${shape.wide}`);
      await ph.shot('phone-inbox-retry');

      // Retry: the last message of yours goes again as a new turn
      await tap(ph, `${CARD} [data-act=retry]`);
      for (let i = 0; i < 100 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 100));
      assertEquals(prompts.length, 1, 'one prompt');
      assertEquals([prompts[0].id, prompts[0].text], ['c-fail', 'Add the coupon field']);
      assert(String(prompts[0].clientMessageId).startsWith('retry-claude:sess-c-fail-'), String(prompts[0].clientMessageId));
      const log = s.ctx.phone.audit.tail(200).map((e) => `${e.action}: ${e.result}`);
      assert(log.includes('chat menu: inbox retry'), log.join(' | '));
      assertEquals(ph.errors, [], 'phone console errors');

      // a row that is no longer failed: refused, nothing sent
      let r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c-fail', op: 'retry' });
      assertEquals([r.status, r.json.code], [409, 'gone']);

      // Send off: no Retry on the card, and the route refuses
      failed.busy = false;
      failed.attention = { state: 'idle', needs: 0, turnEndedAt: ago(1), busySince: null, failedAt: new Date().toISOString(), error: 'Rate limit reached' };
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read'] });
      await ph.waitFor(
        `!!document.querySelector(${JSON.stringify(CARD)}) && !document.querySelector(${JSON.stringify(CARD + ' [data-act=retry]')})`,
        15000,
        'Retry hidden without Send',
      );
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c-fail', op: 'retry' });
      assertEquals(r.status, 403);
      assert(String(r.json.error).startsWith('Retry needs "Send messages, stop turns and continue chats"'), String(r.json.error));
      assertEquals(prompts.length, 1, 'nothing sent');
      const after = s.ctx.phone.audit.tail(200).map((e) => `${e.action}: ${e.result}`);
      assert(after.includes('chat menu: refused: scope'), after.join(' | '));
      await ph.close();
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
