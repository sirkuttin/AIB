/**
 * Inbox v3.1 phase 3, Snooze end to end, in headless Chrome (no window) against an in-process AIB with a fake agent host and a
 * paired phone:
 *  - every Needs-you row shows a visible alarm-clock icon (the owner: "We shouldn't be hiding things"), in the same 24 px box as a
 *    row's ×, monochrome, with a tooltip, in the dark and the light theme; the phone card shows it in the ×'s 44 px box;
 *  - its menu offers "1 hour" / "Tomorrow 9:00"; picking one takes the row out and the count drops (PC badge, route, phone); a
 *    quiet "1 snoozed" foot opens the Snoozed section with the wake time and Wake now;
 *  - the snooze lives in the chat's marks (never Hold) and survives a restart (a fresh store and inbox read it back);
 *  - the row comes back on time with ONE "Back:" notification, and early when the chat changes (snoozed from the phone, then a new
 *    failure) with one notification, never two.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { liveChat, v2Aib } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { AttentionWatcher, type Fire } from '../../app/server/attention/watcher.ts';
import { InboxService } from '../../app/server/attention/inbox.ts';
import { ConversationState } from '../../app/server/state/conversations.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const ONCE = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];
const soon = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();

Deno.test({
  ...OPTS,
  name: 'inbox v3.1 phase 3: a visible snooze icon, the row leaves and comes back on time and on a change, PC and phone alike',
  ignore: !browserPath,
  async fn() {
    const s = await v2Aib();
    const browser = await Browser.launch();
    try {
      const fired: Fire[] = [];
      const watcher = new AttentionWatcher(
        { ...s.ctx, inbox: s.ctx.inbox },
        { stateDir: s.state, onFire: (f) => void fired.push(...f), kinds: () => ({ worktree: false, scratch: false }), settleMs: 0 },
      );
      const ask = liveChat('c-ask', s.project, {
        breadth: { sessionInfo: { title: 'Payments' } },
        attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null },
        permissions: [{ key: 'p1', params: { toolCall: { title: 'Bash', toolCallId: 'tc-1', rawInput: { command: 'npm install stripe@18.0.0' } }, options: ONCE } }],
      });
      const fail = liveChat('c-fail', s.project, {
        breadth: { sessionInfo: { title: 'PDF totals' } },
        attention: { state: 'idle', needs: 0, turnEndedAt: soon(1), busySince: null, failedAt: soon(1), error: 'Usage limit reached.' },
      });
      const done = liveChat('c-done', s.project, { breadth: { sessionInfo: { title: 'Docs page' } } });
      s.chats.push(ask, fail, done);
      await s.ctx.conversations.apply('your_turn', 'claude', 'sess-c-done');
      await watcher.poll(); // the first news: announced now, so later polls show only what snooze changes
      fired.length = 0;

      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('document.querySelector(".ws-inbox-btn .ws-badge")?.textContent === "2"', 20000, 'the badge');
      await page.click('.ws-inbox-btn');
      await page.waitFor('document.querySelectorAll("#wsInbox .ws-qa-snooze").length === 2', 10000, 'a snooze icon on each Needs-you row');

      // visible, monochrome, the ×'s box, a tooltip; dark and light theme
      for (const theme of ['teal-dark', 'teal-light']) {
        await page.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
        const look = await page.eval<Json>(`(() => {
          const z = document.querySelector('#wsInbox .ws-inbox-item[data-key="claude:sess-c-ask"] .ws-qa-snooze');
          const x = document.querySelector('#wsInbox .ws-qa-read');
          const zr = z.getBoundingClientRect(), xr = x.getBoundingClientRect(), svg = z.querySelector('svg').getBoundingClientRect();
          const cs = getComputedStyle(z), xs = getComputedStyle(x), bg = getComputedStyle(document.getElementById('wsInbox')).backgroundColor;
          return { zw: Math.round(zr.width), zh: Math.round(zr.height), xw: Math.round(xr.width), xh: Math.round(xr.height), sw: Math.round(svg.width),
            color: cs.color, xcolor: xs.color, bg, vis: cs.visibility, op: cs.opacity, title: z.title, fill: cs.backgroundColor };
        })()`);
        assertEquals([look.zw, look.zh], [look.xw, look.xh], `${theme}: the ×'s box ${JSON.stringify(look)}`);
        assertEquals(look.zw, 24);
        assert(Number(look.sw) >= 12 && Number(look.sw) <= 18, `${theme}: a visible glyph ${JSON.stringify(look)}`);
        assertEquals(look.color, look.xcolor, `${theme}: monochrome, the ×'s quiet colour`);
        assert(look.color !== look.bg && look.vis === 'visible' && look.op === '1', `${theme}: visible ${JSON.stringify(look)}`);
        assertEquals(look.fill, 'rgba(0, 0, 0, 0)', `${theme}: not filled`);
        assert(/Snooze/.test(String(look.title)), 'a tooltip');
        await page.shot('inbox-snooze-' + theme);
      }

      // the menu: 1 hour / Tomorrow 9:00; 1 hour takes the row out and the count drops
      await page.eval('document.querySelector(\'#wsInbox .ws-inbox-item[data-key="claude:sess-c-ask"] .ws-qa-snooze\').click()');
      await page.waitFor('!!document.querySelector(".ws-snooze-menu")', 5000, 'the snooze menu');
      assertEquals(await page.eval('[...document.querySelectorAll(".ws-snooze-menu .ws-snooze-label")].map((n) => n.textContent)'), ['1 hour', 'Tomorrow 9:00']);
      await page.eval('[...document.querySelectorAll(".ws-snooze-menu .ws-menu-item")][0].click()');
      await page.waitFor('!document.querySelector(\'#wsInbox .ws-inbox-item[data-key="claude:sess-c-ask"]\')', 8000, 'the row leaves');
      await page.waitFor('document.querySelector(".ws-inbox-btn .ws-badge")?.textContent === "1"', 8000, 'the count drops');
      const mark = s.ctx.conversations.public().entries['claude:sess-c-ask'];
      assert(Number(mark.snoozedUntil) > Date.now() / 1000 + 3500 && !mark.holdAt, `saved in the marks, never Hold: ${JSON.stringify(mark)}`);
      const [, inbox] = await pc(s, 'GET', '/api/live/inbox?fresh=1');
      assertEquals(inbox.count, 1);
      assertEquals((inbox.snoozed as Json[]).map((x) => x.key), ['claude:sess-c-ask']);
      // the foot: "1 snoozed" opens the Snoozed section
      assertEquals(await page.eval('document.querySelector("#wsInbox .ws-inbox-snoozed-link").textContent'), '1 snoozed');
      await page.eval('document.querySelector("#wsInbox .ws-inbox-snoozed-link").click()');
      await page.waitFor('!!document.querySelector("#wsInbox .ws-s-snoozed")', 5000, 'the Snoozed section');
      const sz = await page.eval<Json>(`(() => { const r = document.querySelector('#wsInbox .ws-s-snoozed');
        return { age: r.querySelector('.ws-inbox-age').textContent, wake: r.querySelector('.ws-qa-wake').textContent }; })()`);
      assert(/^until \d{1,2}:\d{2}$|^until tomorrow /.test(String(sz.age)), String(sz.age));
      assertEquals(sz.wake, 'Wake now');
      await page.shot('inbox-snoozed-section');
      assertEquals(page.errors, [], 'console errors');

      // survives a restart: a fresh marks store and inbox read the snooze back
      const fresh = new InboxService({ ...s.ctx, conversations: new ConversationState(s.state) });
      const again = await fresh.look();
      assertEquals(again.snoozed.map((x) => x.key), ['claude:sess-c-ask'], 'still snoozed after a restart');

      // the phone: same rows, the icon in the ×'s 44 px box, "1 snoozed" at the foot
      const phone = await pairPhone(s);
      const ph = await phonePage(browser, s, phone);
      await ph.waitFor('document.querySelector("#phInbox .ph-env-badge")?.textContent === "1"', 15000, 'the phone badge');
      await tap(ph, '#phInbox');
      await ph.waitFor('!!document.getElementById("phSnoozedFoot")', 8000, 'the snoozed foot');
      assertEquals(await ph.eval('document.getElementById("phSnoozedFoot").textContent'), '1 snoozed');
      const pz = await ph.eval<Json>(`(() => {
        const c = document.querySelector('.ph-icard[data-key="claude:sess-c-fail"]');
        const z = c.querySelector('button[data-act=snooze]').getBoundingClientRect();
        const x = document.querySelector('.ph-icard[data-key="claude:sess-c-done"] button[data-act=handled]').getBoundingClientRect();
        return { z: [Math.round(z.width), Math.round(z.height)], x: [Math.round(x.width), Math.round(x.height)], svg: !!c.querySelector('button[data-act=snooze] svg') };
      })()`);
      assertEquals(pz.z, pz.x, `the phone icon fills the ×'s box ${JSON.stringify(pz)}`);
      assert(pz.svg, 'an icon');

      // early wake on a change: snoozed from the phone (until tomorrow), then a new failure
      await tap(ph, '.ph-icard[data-key="claude:sess-c-fail"] button[data-act=snooze]');
      await tap(ph, '.ph-icard[data-key="claude:sess-c-fail"] button[data-act="snooze-tomorrow"]');
      await ph.waitFor('document.getElementById("phSnoozedFoot")?.textContent === "2 snoozed"', 10000, 'two snoozed');
      assertEquals(s.ctx.conversations.public().entries['claude:sess-c-fail'].snoozeSig !== undefined, true);
      fail.attention = { ...fail.attention, failedAt: soon(5), error: 'Usage limit reached again.' };
      await watcher.poll();
      await watcher.poll();
      const failNews = fired.filter((f) => f.key === 'claude:sess-c-fail');
      assertEquals(failNews.length, 1, `one notification: ${JSON.stringify(fired)}`);
      assertEquals(failNews[0].reason, 'wake');
      assertEquals(failNews[0].what, 'Back: Usage limit reached again.');
      assertEquals(s.ctx.conversations.public().entries['claude:sess-c-fail']?.snoozedUntil, undefined, 'the snooze is dropped');

      // on time: the hour passed (moved back in the marks), the row is back with one "Back:" notification
      const m = s.ctx.conversations.public().entries['claude:sess-c-ask'];
      await s.ctx.conversations.setInbox('claude', 'sess-c-ask', { snoozedUntil: Date.now() / 1000 - 1, snoozedAt: Number(m.snoozedAt), snoozeSig: String(m.snoozeSig) });
      await watcher.poll();
      await watcher.poll();
      const back = fired.filter((f) => f.key === 'claude:sess-c-ask');
      assertEquals(back.length, 1, JSON.stringify(fired));
      assertEquals(back[0].what, 'Back: Run npm install stripe@18.0.0');
      const [, after] = await pc(s, 'GET', '/api/live/inbox?fresh=1');
      assertEquals(after.count, 2, 'both back in Needs you');
      assertEquals(after.snoozed, []);
      await page.waitFor('document.querySelector(".ws-inbox-btn .ws-badge")?.textContent === "2"', 10000, 'the PC count is back');
      await page.close();
      await watcher.stop();
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
