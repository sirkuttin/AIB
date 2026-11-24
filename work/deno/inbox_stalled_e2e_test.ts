/**
 * Inbox v3.1 phase 2, stalled rows end to end. An in-process AIB with a fake agent host lists three stalled chats as the agent
 * connection reports them (server/acp/connection.ts; inbox_stalled_test.ts proves those facts with the fake agent): one whose agent
 * died mid-turn (S1, its connection closed), one whose turn ended without a final message (S2), one gone quiet while working (S3).
 *  - the AttentionWatcher saves S1 / S2 in the chat's mark (the S1 row outlives its connection) and sends ONE notification per
 *    stall, worded with the row's line 1, never twice;
 *  - each is a Needs-you row (it counts) on the PC, in headless Chrome, with Continue · Reply · Mark handled, and on the phone with
 *    Continue · Reply · ×;
 *  - Continue sends "Continue where you left off.": S2 at once; S3 after stopping the hung turn; S1 after opening the chat again
 *    from its saved session; each row then leaves.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { liveChat, v2Aib } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { AttentionWatcher, type Fire } from '../../app/server/attention/watcher.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const soon = (sec: number) => new Date(Date.now() + sec * 1000).toISOString(); // after the watcher started: news

Deno.test({
  ...OPTS,
  name: 'inbox v3.1 phase 2: each stall signal is a Needs-you row with one notification, and Continue works on the PC',
  ignore: !browserPath,
  async fn() {
    const s = await v2Aib();
    const browser = await Browser.launch();
    try {
      const died = liveChat('c-died', s.project, {
        closed: true,
        breadth: { sessionInfo: { title: 'Checkout flow' } },
        attention: { state: 'closed', needs: 0, turnEndedAt: null, busySince: null, stalledAt: soon(1), stallKind: 'died', stallStep: 'npm test' },
      });
      const silent = liveChat('c-silent', s.project, {
        breadth: { sessionInfo: { title: 'Cart refactor' } },
        attention: { state: 'idle', needs: 0, turnEndedAt: ago(2), busySince: null, stalledAt: soon(2), stallKind: 'silent_end', stallStep: 'Edit src/cart.ts' },
      });
      const quiet = liveChat('c-quiet', s.project, {
        busy: true,
        breadth: { sessionInfo: { title: 'Startup speed' } },
        attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: ago(25), stalledAt: soon(3), stallKind: 'quiet', stallStep: 'Read server/main.ts' },
      });
      s.chats.push(died, silent, quiet);
      const calls: [string, Json][] = [];
      s.answerLive((name, body) => {
        calls.push([name, body]);
        if (name === 'cancel') {
          quiet.busy = false;
          quiet.attention = { state: 'idle', needs: 0, turnEndedAt: new Date().toISOString(), busySince: null };
        }
        if (name === 'connect') {
          // the chat opens again from its saved session (the same sessionId)
          died.closed = false;
          died.attention = { state: 'idle', needs: 0, turnEndedAt: null, busySince: null };
          return [200, { id: 'c-died', provider: 'claude' }];
        }
        if (name === 'prompt') {
          const c = s.chats.find((x) => x.id === body.id)!;
          c.attention = { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() };
          c.busy = true;
          // sending is acting: the agent host marks the chat handled (aib.ts), so a saved stall is over too
          void s.ctx.conversations.apply('handled', 'claude', c.sessionId);
        }
        return [200, { ok: true, accepted: true }];
      });

      // the watcher: saves S1 / S2 as marks, one notification per stall
      const fired: Fire[] = [];
      const watcher = new AttentionWatcher(
        { ...s.ctx, inbox: s.ctx.inbox },
        { stateDir: s.state, onFire: (f) => void fired.push(...f), kinds: () => ({ worktree: false, scratch: false }), settleMs: 0 },
      );
      await watcher.poll();
      await watcher.poll();
      await watcher.poll();
      const stalls = fired.filter((f) => f.reason === 'stalled');
      assertEquals(stalls.map((f) => f.key).sort(), ['claude:sess-c-died', 'claude:sess-c-quiet', 'claude:sess-c-silent'], JSON.stringify(fired));
      assertEquals(stalls.find((f) => f.key === 'claude:sess-c-died')!.what, 'Stopped mid-work: the agent quit during npm test');
      assert(!fired.some((f) => f.kind === 'turn'), 'a stalled turn is not "finished"');
      const marks = s.ctx.conversations.public().entries;
      assertEquals(marks['claude:sess-c-died'].stallKind, 'died', 'S1 saved as a mark');
      assertEquals(marks['claude:sess-c-silent'].stallKind, 'silent_end', 'S2 saved as a mark');
      assertEquals(marks['claude:sess-c-quiet'], undefined, 'S3 is live only');

      // S1 outlives its connection: the agent host no longer lists it, the mark keeps the row
      s.chats.splice(s.chats.indexOf(died), 1);
      const [, inbox] = await pc(s, 'GET', '/api/live/inbox?fresh=1');
      const rows = inbox.rows as Json[];
      assertEquals(rows.map((r) => r.kind), ['stalled', 'stalled', 'stalled']);
      assertEquals(inbox.count, 3);
      assertEquals(rows.map((r) => r.what), [
        'Stopped mid-work: the agent quit during npm test',
        'Stopped without a final message, after Edit src/cart.ts',
        'No output for 20 minutes, last: Read server/main.ts',
      ]);
      s.chats.push(died);

      // the PC: Continue · Reply · Mark handled on each
      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('document.querySelector(".ws-inbox-btn .ws-badge")?.textContent === "3"', 20000, 'the badge');
      await page.click('.ws-inbox-btn');
      await page.waitFor('document.querySelectorAll("#wsInbox .ws-r-stalled").length === 3', 10000, 'three stalled rows');
      const labels = await page.eval<string[][]>(
        '[...document.querySelectorAll("#wsInbox .ws-r-stalled")].map((r) => [...r.querySelectorAll(".ws-qa")].map((b) => b.textContent))',
      );
      for (const l of labels) assertEquals(l, ['Continue', 'Reply', 'Mark handled', ''], 'and the snooze icon (phase 3)');
      await page.shot('inbox-stalled');

      // the phone: Continue · Reply · ×
      const phone = await pairPhone(s);
      const ph = await phonePage(browser, s, phone);
      await ph.waitFor('document.querySelector("#phInbox .ph-env-badge")?.textContent === "3"', 15000, 'the phone badge');
      await tap(ph, '#phInbox');
      await ph.waitFor('document.querySelectorAll(".ph-icard[data-kind=stalled]").length === 3', 8000, 'stalled cards');
      const phoneActs = await ph.eval<string[][]>(
        '[...document.querySelectorAll(".ph-icard[data-kind=stalled]")].map((c) => [...c.querySelectorAll(".ph-iacts button")].map((b) => b.dataset.act))',
      );
      for (const a of phoneActs) assertEquals(a, ['continue', 'reply', 'handled', 'snooze']);

      // Continue on each (PC): S2 sends at once, S3 stops first, S1 opens the chat again first
      const cont = async (key: string) => {
        await page.waitFor(`!!document.querySelector('#wsInbox .ws-inbox-item[data-key="${key}"] .ws-qa-continue')`, 8000, key);
        await page.eval(`document.querySelector('#wsInbox .ws-inbox-item[data-key="${key}"] .ws-qa-continue').click()`);
        await page.waitFor(`!document.querySelector('#wsInbox .ws-inbox-item[data-key="${key}"]')`, 20000, `${key} leaves`);
      };
      await cont('claude:sess-c-silent');
      await cont('claude:sess-c-quiet');
      await cont('claude:sess-c-died');
      const names = calls.map(([n, b]) => `${n}:${b.id ?? b.resume ?? ''}`);
      const prompts = calls.filter(([n]) => n === 'prompt');
      assertEquals(prompts.map(([, b]) => b.id), ['c-silent', 'c-quiet', 'c-died'], names.join(' '));
      for (const [, b] of prompts) assertEquals(b.text, 'Continue where you left off.');
      assert(names.indexOf('cancel:c-quiet') >= 0 && names.indexOf('cancel:c-quiet') < names.indexOf('prompt:c-quiet'), `S3 stops first: ${names}`);
      assert(names.indexOf('connect:sess-c-died') >= 0 && names.indexOf('connect:sess-c-died') < names.indexOf('prompt:c-died'), `S1 opens first: ${names}`);
      assertEquals(page.errors, [], 'console errors');
      await page.close();
      await watcher.stop();
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
