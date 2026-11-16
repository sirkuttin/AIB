/**
 * Back steps on the phone page (owner, 2026-11-16: "the back gesture in Android just straight closing the page"), in a headless
 * Chrome at 412 x 915 against an in-process AIB with a fake agent host. The browser's own Back (DevTools history, as the Android
 * gesture) goes one step at a time:
 * - the chat list -> a chat -> its Artifacts page -> an artifact, then Back x3: artifact closes, Artifacts page, chat, the list at
 *   the same scroll and project filter;
 * - a sheet (a card's menu, the project picker) opens one entry; Back closes it and stays on the list;
 * - polls add no entries; Forward then the in-page "‹ Chats" leaves the history as it was;
 * - Back on the list leaves the page (nothing is trapped);
 * - a notification's link (/phone.html#chat=…) opens the chat with the list under it: Back -> the list, Back again -> out.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { NAME, pairPhone } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, serveFor, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const W = 412, H = 915;
type Json = Record<string, unknown>;
const enc = (t: string) => new TextEncoder().encode(t);

async function phoneSize(page: Page): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await page.waitFor(`document.documentElement.clientWidth === ${W}`, 5000, 'size');
}
async function history(page: Page): Promise<{ i: number; n: number; ids: number[] }> {
  const h = await page.send('Page.getNavigationHistory');
  const entries = h.entries as Json[];
  return { i: h.currentIndex as number, n: entries.length, ids: entries.map((e) => e.id as number) };
}
/** The page's history calls have all run (a go(-n) lands with its popstate). */
const settled = (page: Page) => page.waitFor('!window.__aibNav.busy && !window.__aibNav.ops.length', 5000, 'history settled');
async function step(page: Page, by: -1 | 1): Promise<void> {
  const h = await history(page);
  await page.send('Page.navigateToHistoryEntry', { entryId: h.ids[h.i + by] });
}
const screen = (page: Page, name: string) =>
  page.waitFor(`document.getElementById('app').dataset.screen === ${JSON.stringify(name)}`, 8000, 'screen ' + name);

Deno.test({
  ...OPTS,
  name: 'phone back steps: list -> chat -> artifacts -> artifact and back, sheets close, scroll and filter kept, root leaves, link opens over the list',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      for (let i = 1; i <= 14; i++) s.chats.push(liveChat('c' + i, s.project));
      const store = s.ctx.artifacts.store;
      store.create('claude:sess-c1', 'Checkout flow preview', 'pdf', 'flow.pdf', enc('%PDF-1.4 v1'));
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone, undefined, W);
      await phoneSize(page);
      await page.click('.ph-head h1'); // a person's first touch (a browser skips entries a page adds before one)
      await settled(page);
      const root = await history(page);

      // ---- a sheet: the project picker, then a card's menu; Back closes each and stays on the list
      await page.click('#phFilter');
      await page.waitFor('!!document.querySelector(".ph-flist")', 5000, 'picker open');
      await settled(page);
      assertEquals((await history(page)).i, root.i + 1, 'the picker is one entry');
      await step(page, -1);
      await page.waitFor('!document.querySelector(".ph-flist")', 5000, 'Back closes the picker');
      assertEquals((await history(page)).i, root.i);
      // picking a project closes the picker and takes its entry back
      await page.click('#phFilter');
      await page.waitFor('!!document.querySelector(".ph-flist")', 5000, 'picker open');
      await tap(page, `.ph-flist [data-project="${s.projectId}"]`);
      await page.waitFor('!document.querySelector(".ph-flist")', 5000, 'picked');
      await settled(page);
      assertEquals((await history(page)).i, root.i, 'no entry left behind by the picker');
      assertEquals(await page.eval('window.__aibPhone.filter'), s.projectId);
      await tap(page, '[data-menu-for="l:c1"]');
      await page.waitFor('!!document.getElementById("phMenu")', 5000, 'menu');
      await settled(page);
      assertEquals((await history(page)).i, root.i + 1, 'the menu is one entry');
      await step(page, -1);
      await page.waitFor('!document.getElementById("phMenu")', 5000, 'Back closes the menu');
      await screen(page, 'home');
      await settled(page);
      assertEquals((await history(page)).i, root.i);

      // ---- list -> chat -> Artifacts -> artifact
      const y = await page.eval<number>(
        `(() => { window.scrollTo(0, Math.min(350, document.documentElement.scrollHeight - innerHeight)); return window.scrollY; })()`,
      );
      assert(y > 100, `the list scrolls (${y})`);
      await page.waitFor(`window.__aibPhone.homeY === ${y}`, 3000, 'scroll seen');
      await tap(page, '[data-chat="c1"]');
      await screen(page, 'chat');
      await settled(page);
      assertEquals((await history(page)).i, root.i + 1, 'the chat');
      await new Promise((r) => setTimeout(r, 2500)); // polls redraw the chat: no new entries
      assertEquals((await history(page)).n, root.i + 2, 'polls add no entries');
      await page.waitFor('!!document.querySelector("#phArtsBtn .ph-cnt")', 15000, '▤ count');
      await tap(page, '#phArtsBtn');
      await page.waitFor('document.getElementById("app").dataset.screen === "arts" && !!document.querySelector(".ph-art[data-artifact]")', 15000, 'arts');
      await tap(page, '.ph-art[data-artifact]');
      await page.waitFor('!!document.getElementById("viewerClose")', 15000, 'viewer');
      await settled(page);
      assertEquals((await history(page)).i, root.i + 3, 'list, chat, artifacts, artifact');

      // ---- Back x3
      await step(page, -1);
      await page.waitFor('!document.getElementById("viewerClose")', 5000, 'Back closes the artifact');
      await screen(page, 'arts');
      await step(page, -1);
      await page.waitFor(`document.getElementById('app').dataset.screen === 'chat' && window.__aibPhone.chatId === 'c1'`, 8000, 'Back: the chat');
      await step(page, -1);
      await screen(page, 'home');
      await page.waitFor(`Math.abs(window.scrollY - ${y}) < 2`, 5000, `the list where it was (${y})`);
      assertEquals(await page.eval('window.__aibPhone.filter'), s.projectId, 'the project filter kept');
      assert(String(await page.eval('document.getElementById("phFilter").textContent')).includes('▾'));
      await settled(page);
      const at = await history(page);
      assertEquals(at.i, root.i);

      // ---- Forward, then the in-page ‹ Chats: the history goes back too (no entry added)
      await step(page, 1);
      await page.waitFor(`document.getElementById('app').dataset.screen === 'chat' && window.__aibPhone.chatId === 'c1'`, 8000, 'Forward: the chat');
      await settled(page);
      await tap(page, '#phBack');
      await screen(page, 'home');
      await settled(page);
      const after = await history(page);
      assertEquals([after.i, after.n], [at.i, at.n], 'in-page Back stepped the history back');

      // ---- Back on the list leaves the page
      await page.eval('window.__backMark = 1');
      await step(page, -1);
      await page.waitFor('typeof window.__backMark === "undefined"', 8000, 'another page');

      // ---- a notification's link: the chat over the list
      const p2 = await browser.open('about:blank', W, H);
      await p2.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
      await serveFor(p2, s);
      await p2.goto(`https://${NAME}/phone.html#chat=c2`);
      await p2.waitFor(`document.getElementById('app').dataset.screen === 'chat' && window.__aibPhone.chatId === 'c2'`, 15000, 'the linked chat');
      assertEquals(await p2.eval('location.hash'), '', 'the link leaves the address');
      await p2.click('.ph-head h1');
      await settled(p2);
      const h2 = await history(p2);
      assertEquals(h2.i, h2.n - 1);
      await step(p2, -1);
      await screen(p2, 'home');
      await settled(p2);
      await p2.eval('window.__backMark = 1');
      await step(p2, -1);
      await p2.waitFor('typeof window.__backMark === "undefined" && location.href === "about:blank"', 8000, 'out of the page');
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
