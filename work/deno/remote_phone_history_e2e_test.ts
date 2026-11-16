/**
 * Phone history in a headless Chrome (no window) at 375 px, where this test plays Tailscale Serve, against an in-process AIB with a
 * fake agent host (the owner: "we can barely see any history of a chat, it's really hard to even see one whole message"):
 *  - a 5,000-character reply streamed as 1,000 chunks shows whole (it used to lose its beginning to a 300-event cut);
 *  - Load earlier messages (the button, and by itself when you scroll to the top) puts older messages in front without moving
 *    what you were reading; the events stay one per seq, in order, with no hole;
 *  - a poll while a long reply streams in never trims the front of that reply (older whole turns go instead).
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pairPhone } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;

const chunk = (seq: number, text: string): Json => ({
  seq,
  kind: 'update',
  time: Date.now() / 1000 - 100,
  data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});
const user = (seq: number, text: string): Json => ({ seq, kind: 'user', time: Date.now() / 1000 - 100, data: { text } });

/** The agent's messages on screen (their text). */
const shown = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('.ph-msg.agent .ph-text')].map((t) => t.textContent)`);

async function openChat(page: Page, id: string): Promise<void> {
  await tap(page, `.ph-card[data-chat="${id}"]`);
  await page.waitFor(`document.getElementById("app").dataset.screen === "chat" && !!document.querySelector('.ph-msg')`, 15000, 'the chat');
}

Deno.test({
  ...OPTS,
  name: 'phone history: a 5,000-character streamed reply shows whole; Load earlier (button and scroll) keeps your place',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      // c-one: one prompt and a 5,000-character reply in 1,000 chunks of 5 characters
      const one: Json[] = [user(1, 'Write it all')];
      one.push(chunk(2, 'BEGIN'));
      for (let i = 0; i < 998; i++) one.push(chunk(one.length + 1, 'abcd '));
      one.push(chunk(one.length + 1, 'ENDS!'));
      // c-many: 60 turns with an 8 KB reply each (~500 KB): the open page (256 KB) holds about half
      const many: Json[] = [];
      for (let t = 0; t < 60; t++) {
        many.push(user(many.length + 1, `Question ${t}`));
        for (let c = 0; c < 4; c++) many.push(chunk(many.length + 1, (c === 0 ? `Answer ${t} ` : '') + 'lorem ipsum '.repeat(170)));
      }
      s.chats.push(
        liveChat('c-one', s.project, { breadth: { sessionInfo: { title: 'One long reply' } }, events: one }),
        liveChat('c-many', s.project, { breadth: { sessionInfo: { title: 'Many turns' } }, events: many }),
      );
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);

      await openChat(page, 'c-one');
      const texts = await shown(page);
      assertEquals(texts.length, 1, JSON.stringify(texts.map((t) => t.slice(0, 30))));
      const text = texts[0].trim();
      assert(text.startsWith('BEGIN') && text.endsWith('ENDS!'), `whole: ${text.slice(0, 20)} … ${text.slice(-20)}`);
      assertEquals(text.length, 5000);
      assertEquals(await page.eval('!!document.getElementById("phEarlierGo")'), false, 'nothing earlier to load');
      assertEquals(await page.eval(`document.body.innerText.includes('Earlier messages are on your PC')`), false);

      // a chat with more history than one page: Load earlier messages
      await page.eval('document.querySelector(".ph-back").click()');
      await page.waitFor('document.getElementById("app").dataset.screen === "home"', 8000, 'home');
      await openChat(page, 'c-many');
      await page.waitFor('!!document.getElementById("phEarlierGo")', 8000, 'Load earlier messages');
      assertEquals(await page.eval('document.getElementById("phEarlierGo").textContent'), 'Load earlier messages');
      const before = await page.eval<Json>(`(() => {
        const S = window.__aibPhone;
        return { n: S.chatEvents.length, first: S.chat.firstSeq, y: window.scrollY };
      })()`);
      assert(Number(before.first) > 1 && Number(before.y) > 300, JSON.stringify(before));
      // the button (the page is at its end: no scroll loading): the last message stays where it is on screen
      const lastTop = () => page.eval<number>(`Math.round([...document.querySelectorAll('.ph-msg')].at(-1).getBoundingClientRect().top)`);
      const top0 = await lastTop();
      await page.eval('document.getElementById("phEarlierGo").click()');
      const grew = `(() => { const S = window.__aibPhone; return !S.older.busy && S.chatEvents.length > ${before.n}; })()`;
      await page.waitFor(grew, 10000, 'the earlier page');
      const top1 = await lastTop();
      assert(Math.abs(top1 - top0) <= 2, `no jump: the last message was at ${top0}, now ${top1}`);
      const mid = await page.eval<Json>('({ first: window.__aibPhone.chat.firstSeq, more: window.__aibPhone.chat.truncated })');
      assert(Number(mid.first) < Number(before.first), JSON.stringify(mid));

      // scrolled to the top: the next page comes by itself; the message you looked at stays where it was
      const anchor = await page.eval<Json>(`(() => {
        window.scrollTo(0, 0);
        const m = [...document.querySelectorAll('.ph-msg.you')][1];
        return { text: m.textContent, top: Math.round(m.getBoundingClientRect().top) };
      })()`);
      const scrolled = `(() => { const S = window.__aibPhone; return !S.older.busy && S.chat.firstSeq < ${mid.first}; })()`;
      await page.waitFor(scrolled, 10000, 'loaded by scrolling');
      // a page may bring the next one at once (still near the top): wait until it settles
      const settled = `(() => { const S = window.__aibPhone; return !S.older.busy && (!S.chat.truncated || window.scrollY > 300); })()`;
      await page.waitFor(settled, 15000, 'settled');
      const after = await page.eval<number>(`(() => {
        const m = [...document.querySelectorAll('.ph-msg.you')].find((x) => x.textContent === ${JSON.stringify(anchor.text)});
        return Math.round(m.getBoundingClientRect().top);
      })()`);
      assert(Math.abs(after - Number(anchor.top)) <= 2, `no jump: ${anchor.text} was at ${anchor.top}, now ${after}`);
      // the events: one per seq, in order, no hole, up to the newest
      const seqs = await page.eval<number[]>('window.__aibPhone.chatEvents.map((e) => e.seq)');
      for (let i = 1; i < seqs.length; i++) assertEquals(seqs[i], seqs[i - 1] + 1, `contiguous at ${i}`);
      assertEquals(seqs.at(-1), many.length);
      // every reply whole
      for (const t of await shown(page)) assert(/^Answer \d+ (lorem ipsum ?){680}$/.test(t), t.slice(0, 40));
      // keep going to the very start: the control goes away
      for (let i = 0; i < 10 && (await page.eval<boolean>('window.__aibPhone.chat.truncated')); i++) {
        await page.eval('document.getElementById("phEarlierGo") && document.getElementById("phEarlierGo").click()');
        await page.waitFor('!window.__aibPhone.older.busy', 10000, 'a page');
      }
      assertEquals(await page.eval('window.__aibPhone.chatEvents.length'), many.length);
      assertEquals(await page.eval('!!document.getElementById("phEarlierGo")'), false);
      assertEquals(page.errors, []);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone history: polls while a long reply streams in never trim its front (older whole turns go)',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      // an earlier turn, then a reply streaming in: 1,600 chunks so far (the open page holds it all); polls keep ~2,000 events
      const events: Json[] = [user(1, 'Earlier question'), chunk(2, 'Earlier answer.'), user(3, 'Stream a long one')];
      events.push(chunk(events.length + 1, 'BEGIN '));
      for (let i = 0; i < 1600; i++) events.push(chunk(events.length + 1, 'x'));
      const live = liveChat('c-stream', s.project, {
        breadth: { sessionInfo: { title: 'Streaming' } },
        busy: true,
        attention: { state: 'working', needs: 0, busySince: new Date().toISOString(), turnEndedAt: null },
        events,
      });
      s.chats.push(live);
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);
      await openChat(page, 'c-stream');
      let total = 1600;
      // more chunks arrive between polls (under the delta's 300): the phone's list passes 2,000 events
      for (let round = 0; round < 3; round++) {
        const n = live.events.length;
        for (let i = 0; i < 200; i++) live.events.push(chunk(n + i + 1, 'x'));
        total += 200;
        const last = live.events.length;
        await page.waitFor(`window.__aibPhone.chat && window.__aibPhone.chat.cursor === ${last}`, 15000, `poll ${round}`);
      }
      const texts = await shown(page);
      const reply = texts.at(-1)!.trim();
      assert(reply.startsWith('BEGIN'), 'the front of the streaming reply is kept: ' + reply.slice(0, 20));
      assertEquals(reply.length, 'BEGIN '.length + total);
      const state = await page.eval<Json>(
        `(() => { const S = window.__aibPhone; return { first: S.chatEvents[0].seq, more: S.chat.truncated }; })()`,
      );
      assertEquals(state.first, 3, 'the older turn went, whole; the streaming one starts at your message');
      assertEquals(state.more, true);
      assert(!texts.some((t) => t.includes('Earlier answer')), 'the older turn is off the phone until Load earlier');
      // and Load earlier brings it back
      await page.eval('document.getElementById("phEarlierGo").click()');
      await page.waitFor(`window.__aibPhone.chatEvents[0].seq === 1 && !window.__aibPhone.older.busy`, 10000, 'the older turn');
      assert((await shown(page)).some((t) => t.includes('Earlier answer')));
      assertEquals(page.errors, []);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
