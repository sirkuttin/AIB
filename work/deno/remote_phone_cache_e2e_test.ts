/**
 * Saved copies of chats on the phone (owner decision Q6, 2026-11-16), in a headless Chrome (no window) at 375 px where this test
 * plays Tailscale Serve, against an in-process AIB with a fake agent host. "The PC can't be reached" = Serve answers 502 to the API
 * while the page's own files still come (as from the service worker).
 *  - a chat's copy fills while it is open (IndexedDB `chats` in `aib-phone`, this phone's id on it) and survives a reload;
 *  - with the PC unreachable a saved chat opens from the chat list and from the offline start screen, read only, with "Showing saved
 *    copy from <time>"; Load earlier takes the copy's older pages, then (online again) the PC's, with no hole and no repeat;
 *  - the 5 most recently active chats stay; a chat's copy keeps whole turns under its byte cap; another phone's copies go;
 *  - the copies go on Forget cached chats, when the PC turns the phone's switch off, and when the PC removes the phone.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { NAME } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;

const chunk = (seq: number, text: string): Json => ({
  seq,
  kind: 'update',
  time: Date.now() / 1000 - 100,
  data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});
const user = (seq: number, text: string): Json => ({ seq, kind: 'user', time: Date.now() / 1000 - 100, data: { text } });

/** The copies in the page's IndexedDB (without their events, but with their seqs). */
const IDB_CHATS = `new Promise((resolve) => {
  const r = indexedDB.open('aib-phone');
  r.onsuccess = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains('chats')) { d.close(); resolve([]); return; }
    const q = d.transaction('chats').objectStore('chats').getAll();
    q.onsuccess = () => {
      d.close();
      resolve(q.result.map((x) => ({ key: x.key, device: x.device, src: x.src, n: x.events.length, firstKind: x.events[0] && x.events[0].kind,
        size: x.size, truncated: x.truncated, seqs: x.events.map((e) => e.seq) })));
    };
  };
})`;
const copies = async (page: Page) => {
  await page.eval('window.__aibPhone.copyQ.then(() => true)');
  return (await page.eval<Json[]>(IDB_CHATS)).sort((a, b) => String(a.key).localeCompare(String(b.key)));
};
const keyOf = (id: string) => `claude:sess-${id}`;

async function openChat(page: Page, id: string): Promise<void> {
  await tap(page, `.ph-card[data-chat="${id}"]`);
  await page.waitFor(`document.getElementById("app").dataset.screen === "chat" && !!document.querySelector('.ph-msg')`, 15000, 'the chat');
}
async function back(page: Page, screen = 'home'): Promise<void> {
  await page.eval('document.querySelector(".ph-back").click()');
  await page.waitFor(`document.getElementById("app").dataset.screen === "${screen}"`, 8000, screen);
}
const isCopy = (id: string) => `window.__aibPhone.copies.has(${JSON.stringify(keyOf(id))})`;
const seqsOnScreen = (page: Page) => page.eval<number[]>('window.__aibPhone.chatEvents.map((e) => e.seq)');
function contiguous(seqs: number[], what: string): void {
  for (let i = 1; i < seqs.length; i++) assertEquals(seqs[i], seqs[i - 1] + 1, `${what}: contiguous at ${i}`);
}
/** Load earlier until it stops (the button goes, or stays disabled); returns how many pages came. */
async function loadAll(page: Page, max = 12): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const can = await page.eval<boolean>(`(() => { const b = document.getElementById("phEarlierGo"); return !!b && !b.disabled; })()`);
    if (!can) break;
    const first = await page.eval<number>('window.__aibPhone.chat.firstSeq');
    await page.eval('document.getElementById("phEarlierGo").click()');
    await page.waitFor(`!window.__aibPhone.older.busy && window.__aibPhone.chat.firstSeq < ${first}`, 10000, 'an earlier page');
  }
  return n;
}

/** 60 turns with an 8 KB reply each (~500 KB): the open page (256 KB) holds about half. */
function manyTurns(): Json[] {
  const many: Json[] = [];
  for (let t = 0; t < 60; t++) {
    many.push(user(many.length + 1, `Question ${t}`));
    for (let c = 0; c < 4; c++) many.push(chunk(many.length + 1, (c === 0 ? `Answer ${t} ` : '') + 'lorem ipsum '.repeat(170)));
  }
  return many;
}

Deno.test({
  ...OPTS,
  name: 'phone saved copies: fill online, survive a reload, open while the PC is unreachable; Load earlier from the copy, then the PC',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    const gate = { down: false };
    try {
      const many = manyTurns();
      s.chats.push(
        liveChat('c-small', s.project, {
          breadth: { sessionInfo: { title: 'Small chat' } },
          events: [user(1, 'Hello'), chunk(2, 'Hi there, a small answer.')],
        }),
        liveChat('c-many', s.project, { breadth: { sessionInfo: { title: 'Many turns' } }, events: many }),
      );
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone, undefined, 375, true, gate);

      // fills while online: the chat's events, this phone's id, where the seqs come from
      await openChat(page, 'c-small');
      await page.waitFor(isCopy('c-small'), 8000, 'the copy of c-small');
      assertEquals((await copies(page)).map((r) => [r.key, r.device, r.src, r.n]), [[keyOf('c-small'), phone.id, 'live:c-small', 2]]);
      await back(page);
      await openChat(page, 'c-many');
      await page.waitFor('!!document.getElementById("phEarlierGo")', 8000, 'Load earlier messages');
      const open1 = await page.eval<number>('window.__aibPhone.chat.firstSeq');
      assert(open1 > 1, String(open1));
      await loadAll(page, 1); // one page from the PC: the copy keeps it too
      const f2 = await page.eval<number>('window.__aibPhone.chat.firstSeq');
      assert(f2 < open1 && f2 > 1, `${f2} < ${open1}`);
      await page.waitFor(`window.__aibPhone.copies.get(${JSON.stringify(keyOf('c-many'))})?.firstSeq === ${f2}`, 10000, 'the copy grows');
      await back(page);

      // a reload: the copies are still there
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home');
      assert(await page.eval(`${isCopy('c-small')} && ${isCopy('c-many')}`), 'both copies after a reload');

      // the PC can't be reached: the list goes stale, but the chats saved here still open (and only those)
      gate.down = true;
      await page.waitFor('!!document.querySelector(".ph-offline")', 15000, 'offline');
      const cards = await page.eval<Json[]>(`[...document.querySelectorAll('.ph-cw')].map((w) => ({
        chat: w.querySelector('.ph-card').dataset.chat, ok: w.classList.contains('ph-copy-ok'),
        events: getComputedStyle(w.querySelector('.ph-card')).pointerEvents, tag: (w.querySelector('.ph-copytag') || {}).textContent || '' }))`);
      for (const c of cards) {
        const saved = c.chat === 'c-small' || c.chat === 'c-many';
        assertEquals([c.ok, c.events === 'none'], [saved, !saved], JSON.stringify(c));
        if (saved) assert(String(c.tag).startsWith('Saved copy from '), JSON.stringify(c));
      }
      await tap(page, '.ph-card[data-chat="c-small"]');
      await page.waitFor('!!document.getElementById("phCopyNote") && !!document.querySelector(".ph-msg")', 8000, 'the saved copy');
      assert(/^Showing saved copy from \d/.test(await page.eval<string>('document.getElementById("phCopyNote").textContent')));
      assert(await page.eval<boolean>(`document.body.innerText.includes('Hi there, a small answer.')`));
      assert(await page.eval<boolean>(`!!document.querySelector('main.ph-chat.ph-stale') && !!document.querySelector('.ph-offline')`));
      assertEquals(await page.eval('!!document.getElementById("phPrompt")'), false, 'read only: no message box');
      await back(page);

      // the long chat from its copy: its newest page, then Load earlier from the copy while still offline
      await tap(page, '.ph-card[data-chat="c-many"]');
      await page.waitFor('!!document.getElementById("phCopyNote") && !!document.getElementById("phEarlierGo")', 8000, 'the long copy');
      const off1 = await page.eval<number>('window.__aibPhone.chat.firstSeq');
      assert(off1 > f2, `the copy opens at its newest page: ${off1} > ${f2}`);
      assertEquals(
        await page.eval('getComputedStyle(document.getElementById("phEarlierGo")).pointerEvents'),
        'auto',
        'Load earlier works offline from the copy',
      );
      const pages = await loadAll(page);
      assert(pages >= 1, 'pages from the copy');
      assertEquals(await page.eval('window.__aibPhone.chat.firstSeq'), f2, 'as far as the copy goes');
      assertEquals(await page.eval('document.getElementById("phEarlierGo").disabled'), true, 'the rest is on the PC');
      contiguous(await seqsOnScreen(page), 'from the copy');

      // online again: the PC's answer joins what is on screen (the older events stay), then Load earlier from the PC to the start
      gate.down = false;
      await page.waitFor('!window.__aibPhone.offline && window.__aibPhone.chat && !window.__aibPhone.chat.cached', 15000, 'live again');
      assertEquals(await page.eval('window.__aibPhone.chat.firstSeq'), f2, 'the copy’s older events stayed in front');
      assertEquals(await page.eval('!!document.getElementById("phCopyNote")'), false);
      await loadAll(page);
      const all = await seqsOnScreen(page);
      contiguous(all, 'copy then PC');
      assertEquals([all[0], all.at(-1), all.length], [1, many.length, many.length]);
      await back(page);

      // the page opens while the PC can't be reached: the start screen lists the copies; one opens; Back returns there
      gate.down = true;
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "offline" && !!document.getElementById("phCopies")', 15000, 'offline start');
      const listed = await page.eval<string[]>(`[...document.querySelectorAll('#phCopies [data-copy]')].map((b) => b.dataset.copy).sort()`);
      assertEquals(listed, [keyOf('c-many'), keyOf('c-small')]);
      await tap(page, `#phCopies [data-copy="${keyOf('c-small')}"]`);
      await page.waitFor('!!document.getElementById("phCopyNote") && !!document.querySelector(".ph-msg")', 8000, 'a copy from the start screen');
      assertEquals(await page.eval('document.getElementById("app").dataset.screen'), 'chat');
      await back(page, 'offline');
      // the PC answers again: the page starts as usual
      gate.down = false;
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 20000, 'home again');
      assertEquals(page.errors, []);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone saved copies: the 5 most recently active stay; whole turns under the byte cap; another phone’s copies go',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      for (let i = 1; i <= 7; i++) {
        s.chats.push(
          liveChat(`c-${i}`, s.project, { breadth: { sessionInfo: { title: `Chat ${i}` } }, events: [user(1, `Hi ${i}`), chunk(2, `Answer ${i}`)] }),
        );
      }
      s.chats.push(liveChat('c-many', s.project, { breadth: { sessionInfo: { title: 'Many turns' } }, events: manyTurns() }));
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);
      const visit = async (id: string) => {
        await openChat(page, id);
        await page.waitFor(isCopy(id), 8000, `the copy of ${id}`);
        await back(page);
      };
      for (let i = 1; i <= 6; i++) await visit(`c-${i}`);
      const keys = async () => (await copies(page)).map((r) => r.key);
      assertEquals(await keys(), [2, 3, 4, 5, 6].map((i) => keyOf(`c-${i}`)), 'the oldest went');
      await visit('c-2'); // read again: the most recent now
      await visit('c-7');
      assertEquals(await keys(), [2, 4, 5, 6, 7].map((i) => keyOf(`c-${i}`)), 'c-3 was the least recently active');

      // a chat's copy stays under its byte cap: the oldest whole turns go (it starts at one of your messages)
      await page.eval('window.__aibPhone.copyBytes = 40000');
      await openChat(page, 'c-many');
      await page.waitFor(isCopy('c-many'), 8000, 'the copy of c-many');
      const rec = (await copies(page)).find((r) => r.key === keyOf('c-many'))!;
      assert(Number(rec.size) <= 40000 && Number(rec.size) > 20000, String(rec.size));
      assertEquals([rec.firstKind, rec.truncated], ['user', true]);
      contiguous(rec.seqs as number[], 'the capped copy');
      assertEquals(await page.eval('window.__aibPhone.copies.size'), 5);
      await back(page);

      // another phone's copy (an earlier pairing) is never shown, and goes when the page opens
      await page.eval(`new Promise((resolve) => {
        const r = indexedDB.open('aib-phone');
        r.onsuccess = () => {
          const d = r.result;
          const tx = d.transaction('chats', 'readwrite');
          tx.objectStore('chats').put({ key: 'claude:other', v: 1, device: 'another-phone', src: 'saved', title: 'Not yours', events: [{ seq: 1, kind: 'user', data: { text: 'secret' } }], lastActive: Date.now() + 1e9, savedAt: Date.now(), size: 50 });
          tx.oncomplete = () => { d.close(); resolve(true); };
        };
      })`);
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home');
      assertEquals(await page.eval(`window.__aibPhone.copies.has('claude:other')`), false);
      assert(!(await keys()).includes('claude:other'), 'another phone’s copy is gone');
      assertEquals((await keys()).length, 5);
      assertEquals(page.errors, []);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone saved copies go: Forget cached chats, the PC turns the switch off (and on), the PC removes the phone',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      s.chats.push(
        liveChat('c-a', s.project, { breadth: { sessionInfo: { title: 'Chat A' } }, events: [user(1, 'Hi A'), chunk(2, 'Answer A')] }),
        liveChat('c-b', s.project, { breadth: { sessionInfo: { title: 'Chat B' } }, events: [user(1, 'Hi B'), chunk(2, 'Answer B')] }),
      );
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);
      await openChat(page, 'c-a');
      await page.waitFor(isCopy('c-a'), 8000, 'the copy of c-a');
      await back(page);

      // ⋯ → Saved copies: what is kept and where, then Forget cached chats
      await page.click('#phPhoneMenu');
      await page.waitFor('!!document.querySelector(\'#phMenu [data-mi="copies"]\')', 5000, 'Saved copies item');
      assert(String(await page.eval('document.querySelector(\'#phMenu [data-mi="copies"]\').textContent')).includes('1 chat'));
      await page.eval('document.querySelector(\'#phMenu [data-mi="copies"]\').click()');
      await page.waitFor('!!document.getElementById("phCopiesText")', 5000, 'Saved copies');
      const words = await page.eval<string>('document.getElementById("phCopiesText").textContent');
      assert(words.includes('not encrypted') && words.includes('up to 5 chats'), words);
      assertEquals(await page.eval('!!document.getElementById("phCopiesOff")'), false);
      await page.eval('document.querySelector(\'#phMenu [data-mi="forget"]\').click()');
      await page.waitFor('!document.getElementById("phMenu") && window.__aibPhone.copies.size === 0', 5000, 'forgotten');
      assertEquals(await copies(page), []);

      // the PC turns the switch off: the copies go at the next answer, and none are written while it is off
      await openChat(page, 'c-a');
      await page.waitFor(isCopy('c-a'), 8000, 'saved again');
      const [st] = await pc(s, 'POST', '/api/live/devices/prefs', { id: phone.id, offlineCache: false });
      assertEquals(st, 200);
      await page.waitFor('!window.__aibPhone.scopes.includes("phone.cache") && window.__aibPhone.copies.size === 0', 10000, 'wiped');
      assertEquals(await copies(page), []);
      await back(page);
      await openChat(page, 'c-b');
      const cursor = await page.eval<number>('window.__aibPhone.chat.cursor');
      s.chats.find((c) => c.id === 'c-b')!.events.push(chunk(3, 'More B'));
      await page.waitFor(`window.__aibPhone.chat.cursor > ${cursor}`, 10000, 'a poll');
      assertEquals(await copies(page), [], 'nothing saved while off');
      await back(page);
      await page.click('#phPhoneMenu');
      await page.eval('document.querySelector(\'#phMenu [data-mi="copies"]\').click()');
      await page.waitFor('!!document.getElementById("phCopiesOff")', 5000, 'says it is off on the PC');
      await page.eval('document.querySelector("#phMenu .ph-shade").click()');
      // on again: copies are written again
      await pc(s, 'POST', '/api/live/devices/prefs', { id: phone.id, offlineCache: true });
      await page.waitFor('window.__aibPhone.scopes.includes("phone.cache")', 10000, 'on again');
      await openChat(page, 'c-b');
      await page.waitFor(isCopy('c-b'), 8000, 'saved once on again');

      // the PC removes the phone: its next request is refused, and the copies go with the device token
      const [rs] = await pc(s, 'POST', '/api/live/devices/remove', { id: phone.id });
      assertEquals(rs, 200);
      await page.waitFor('document.getElementById("app").dataset.screen === "removed"', 10000, 'removed');
      assertEquals(await page.eval('window.__aibPhone.copies.size'), 0);
      assertEquals(await copies(page), []);
      assertEquals(page.errors, []);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
