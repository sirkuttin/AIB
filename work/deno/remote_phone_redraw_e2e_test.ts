/**
 * The phone page's polls change only what changed (phase 0 of the native-feel plan, aib-shared/designs/phone-remote/
 * android-dynamic-thin-client-2026-11-16.md §4.4): headless Chrome (no window) at 375 px, where this test plays Tailscale Serve,
 * against an in-process AIB with a fake agent host. A long working chat (25 turns: your message, a reply, a run of steps) streams
 * while you read mid-history with text selected, a steps fold open with Show output open, and later a half-typed message with the
 * caret in the middle (and an IME composition). Across polls:
 *  - no row on screen is replaced or touched (identity and a MutationObserver), the reply streaming in grows in its own node;
 *  - the scroll position, the selection, the open fold and output, the focus, caret and draft stay; the page never scrolls itself;
 *  - a new event is added at the end without moving what you read (scrolled up), and follows the end when you are at the end;
 *  - the chat list: a poll that changes one card keeps every card's node.
 * It prints the cost of one poll (nodes created, nodes put in and taken out of the page, layouts, style recalcs, scroll writes):
 * `PHONE_REDRAW {...}`.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pairPhone } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const SCOPES = ['phone.read', 'phone.answer', 'phone.prompt', 'phone.approve'];

const at = () => Date.now() / 1000 - 100;
const chunk = (seq: number, text: string): Json => ({
  seq,
  kind: 'update',
  time: at(),
  data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});
const user = (seq: number, text: string): Json => ({ seq, kind: 'user', time: at(), data: { text } });
const tool = (seq: number, id: string, title: string): Json => ({
  seq,
  kind: 'update',
  time: at(),
  data: { update: { sessionUpdate: 'tool_call', toolCallId: id, title, status: 'in_progress' } },
});
const done = (seq: number, id: string, out: string): Json => ({
  seq,
  kind: 'update',
  time: at(),
  data: { update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: out } },
});

/** Counters in the page: nodes created (document.create*), nodes put in / taken out of #app (whole subtrees), mutations inside
 * .ph-list outside the streaming row, window.scrollTo calls. */
const INSTRUMENT = `(() => {
  const m = (window.__m = { created: 0, added: 0, removed: 0, listOther: 0, scrollWrites: 0, blur: 0, compEnd: 0 });
  const size = (n) => (n.nodeType === 1 ? 1 + n.getElementsByTagName('*').length : 1);
  for (const k of ['createElement', 'createElementNS', 'createTextNode', 'createComment', 'createDocumentFragment']) {
    const f = Document.prototype[k];
    Document.prototype[k] = function (...a) { m.created++; return f.apply(this, a); };
  }
  for (const k of ['scrollTo', 'scroll', 'scrollBy']) {
    const f = window[k].bind(window);
    window[k] = (...a) => { m.scrollWrites++; return f(...a); };
  }
  new MutationObserver((list) => {
    for (const r of list) {
      for (const n of r.addedNodes) m.added += size(n);
      for (const n of r.removedNodes) m.removed += size(n);
      const row = (r.target.nodeType === 1 ? r.target : r.target.parentNode);
      const inList = row && row.closest && row.closest('.ph-list');
      if (inList && !(window.__tail && window.__tail.contains(r.target))) m.listOther++;
    }
  }).observe(document.getElementById('app'), { childList: true, subtree: true, characterData: true, attributes: true });
  return true;
})()`;

async function metrics(page: Page): Promise<Record<string, number>> {
  const r = await page.send('Performance.getMetrics');
  const out: Record<string, number> = {};
  for (const x of r.metrics as { name: string; value: number }[]) out[x.name] = x.value;
  return out;
}

/** One poll that brings `push()`'s events: what it cost and what moved. */
async function poll(page: Page, live: { events: Json[] }, push: () => void): Promise<Json> {
  const m0 = await metrics(page);
  const c0 = await page.eval<Json>('({ ...window.__m, y: window.scrollY })');
  push();
  await page.waitFor(`window.__aibPhone.chat && window.__aibPhone.chat.cursor === ${live.events.length}`, 15000, 'a poll');
  await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const m1 = await metrics(page);
  const c1 = await page.eval<Json>('({ ...window.__m, y: window.scrollY })');
  const d = (k: string) => Number(c1[k]) - Number(c0[k]);
  return {
    created: d('created'),
    added: d('added'),
    removed: d('removed'),
    listOther: d('listOther'),
    scrollWrites: d('scrollWrites'),
    scrollMoved: Math.abs(d('y')),
    layouts: m1.LayoutCount - m0.LayoutCount,
    styles: m1.RecalcStyleCount - m0.RecalcStyleCount,
    scriptMs: +((m1.ScriptDuration - m0.ScriptDuration) * 1000).toFixed(2),
    layoutMs: +((m1.LayoutDuration - m0.LayoutDuration) * 1000).toFixed(2),
    styleMs: +((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000).toFixed(2),
    blur: d('blur'),
    compEnd: d('compEnd'),
  };
}

Deno.test({
  ...OPTS,
  name: 'phone redraw: polls keep rows, scroll, selection, open fold and output, draft and caret; new rows append; the tail grows in place',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      const events: Json[] = [];
      for (let t = 0; t < 25; t++) {
        events.push(user(events.length + 1, `Question ${t}`));
        events.push(chunk(events.length + 1, `Answer ${t}: ` + 'some **bold** words and `code` here. '.repeat(6) + '\n\n- one\n- two\n'));
        events.push(tool(events.length + 1, 't' + t, `Run step ${t}`));
        events.push(done(events.length + 1, 't' + t, `output of step ${t}\n`.repeat(4)));
      }
      events.push(user(events.length + 1, 'Now stream'));
      events.push(chunk(events.length + 1, 'TAIL start.'));
      const live = liveChat('c-r', s.project, {
        breadth: { sessionInfo: { title: 'Redraw' } },
        busy: true,
        attention: { state: 'working', needs: 0, busySince: new Date().toISOString(), turnEndedAt: null },
        events,
      });
      s.chats.push(live, liveChat('c-b', s.project, { breadth: { sessionInfo: { title: 'Other chat' } } }));
      const phone = await pairPhone(s, 'Pixel 9', SCOPES);
      const page = await phonePage(browser, s, phone);
      await page.send('Performance.enable');
      await tap(page, '.ph-card[data-chat="c-r"]');
      await page.waitFor(`document.getElementById("app").dataset.screen === "chat" && !!document.getElementById("phPrompt")`, 15000, 'the chat');
      await page.waitFor(`[...document.querySelectorAll('.ph-msg.agent')].at(-1).textContent.includes('TAIL start.')`, 8000, 'the tail');
      await page.eval(INSTRUMENT);
      const push = (...more: ((seq: number) => Json)[]) => () => {
        for (const f of more) live.events.push(f(live.events.length + 1));
      };

      // read mid-history: turn 10's steps fold open with Show output open, text selected in turn 12's reply, scrolled to turn 12
      await page.eval(`[...document.querySelectorAll('.ph-steps-fold')][10].querySelector('.ph-fold').click()`);
      await page.waitFor(`!!document.querySelector('.ph-steps-fold.open [data-out]')`, 5000, 'the open fold');
      await page.eval(`document.querySelector('.ph-steps-fold.open button[data-out]').click()`);
      await page.waitFor(`!!document.querySelector('pre.ph-out')`, 8000, 'Show output');
      const setup = await page.eval<Json>(`(() => {
        const m = [...document.querySelectorAll('.ph-msg.agent .ph-text')].find((x) => x.textContent.startsWith('Answer 12:'));
        const y = m.getBoundingClientRect().top + window.scrollY - 200;
        window.scrollTo(0, y);
        const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
        let t = w.nextNode();
        while (t && t.nodeValue.length < 15) t = w.nextNode();
        getSelection().setBaseAndExtent(t, 3, t, 14);
        window.__rows = [...document.querySelectorAll('.ph-list > *')];
        window.__pre = document.querySelector('pre.ph-out');
        window.__tail = [...document.querySelectorAll('.ph-list > .ph-msg.agent')].at(-1);
        window.__anchor = m;
        return { y: window.scrollY, sel: String(getSelection()), top: Math.round(m.getBoundingClientRect().top), out: window.__pre.textContent };
      })()`);
      assert(Number(setup.y) > 500 && String(setup.sel).length === 11, JSON.stringify(setup));
      await page.eval('window.__m.scrollWrites = 0');

      // 1. the tail streams: three polls
      const costs: Json[] = [];
      for (let i = 0; i < 3; i++) costs.push(await poll(page, live, push((q) => chunk(q, ` more ${i}.`))));
      const kept = await page.eval<Json>(`(() => {
        const rows = [...document.querySelectorAll('.ph-list > *')];
        const sel = getSelection();
        return {
          sameRows: rows.length === window.__rows.length && rows.every((r, i) => r === window.__rows[i]),
          y: window.scrollY,
          top: Math.round(window.__anchor.getBoundingClientRect().top),
          sel: String(sel),
          selIn: window.__anchor.contains(sel.anchorNode),
          pre: window.__pre.isConnected && window.__pre.textContent,
          open: !!window.__pre.closest('.ph-steps-fold.open'),
          tail: window.__tail.isConnected && window.__tail.textContent,
        };
      })()`);
      console.log('PHONE_REDRAW streaming poll (scrolled up, selection, open output):', JSON.stringify(costs));
      console.log('PHONE_REDRAW after the streaming polls:', JSON.stringify({ ...kept, tail: undefined, pre: !!kept.pre }));
      assertEquals(kept.sameRows, true, 'no row node replaced');
      assertEquals(kept.y, setup.y, 'the scroll position stays');
      assertEquals(kept.top, setup.top, 'what you read stays where it is');
      assertEquals(kept.sel, setup.sel, 'the selection stays');
      assertEquals(kept.selIn, true);
      assertEquals(kept.pre, setup.out, 'the Show output box stays open, the same node');
      assertEquals(kept.open, true, 'the fold stays open');
      assert(String(kept.tail).includes('TAIL start. more 0. more 1. more 2.'), 'the tail grew in its own node: ' + kept.tail);
      for (const c of costs) {
        assertEquals(c.listOther, 0, 'nothing in the list changed but the streaming reply: ' + JSON.stringify(c));
        assertEquals(c.scrollWrites, 0, 'the page did not scroll itself');
        assert(Number(c.created) < 200, 'a streaming poll draws only the tail (an unchanged row is one placeholder): ' + JSON.stringify(c));
      }

      // 2. a new event while scrolled up: added at the end, what you read does not move
      const appended = await poll(page, live, push((q) => user(q, 'Another question'), (q) => chunk(q, 'Another answer.')));
      const after = await page.eval<Json>(`(() => {
        const rows = [...document.querySelectorAll('.ph-list > *')];
        return {
          prefix: window.__rows.every((r, i) => r === rows[i]),
          added: rows.slice(window.__rows.length).map((r) => (r.querySelector('.ph-text, .ph-bub') || r).textContent.trim()),
          y: window.scrollY,
          top: Math.round(window.__anchor.getBoundingClientRect().top),
          sel: String(getSelection()),
        };
      })()`);
      console.log('PHONE_REDRAW new event (scrolled up):', JSON.stringify(appended));
      assertEquals(after.prefix, true, 'the rows on screen stay');
      assertEquals(after.added, ['Another question', 'Another answer.']);
      assertEquals([after.y, after.top, after.sel], [setup.y, setup.top, setup.sel], 'nothing moved');
      assertEquals(appended.scrollWrites, 0);

      // 3. a half-typed message with the caret in the middle, and an IME composition: polls keep them
      await page.eval(`(() => {
        const p = document.getElementById('phPrompt');
        p.addEventListener('blur', () => window.__m.blur++);
        p.addEventListener('compositionend', () => window.__m.compEnd++);
        p.focus({ preventScroll: true });
        return true;
      })()`);
      await page.type('Hello there world');
      await page.eval(`document.getElementById('phPrompt').setSelectionRange(6, 6)`);
      const typing = await poll(page, live, push((q) => chunk(q, ' typing.')));
      const draft = await page.eval<Json>(`(() => {
        const p = document.getElementById('phPrompt');
        return { focused: document.activeElement === p, value: p.value, caret: [p.selectionStart, p.selectionEnd], y: window.scrollY };
      })()`);
      assertEquals(draft, { focused: true, value: 'Hello there world', caret: [6, 6], y: setup.y });
      assertEquals([typing.blur, typing.scrollWrites], [0, 0]);
      await page.send('Input.imeSetComposition', { text: 'ka', selectionStart: 2, selectionEnd: 2 });
      const ime = await poll(page, live, push((q) => chunk(q, ' ime.')));
      assertEquals([ime.blur, ime.compEnd], [0, 0], 'the composition goes on across a poll');
      await page.send('Input.insertText', { text: 'か' });
      assertEquals(await page.eval(`document.getElementById('phPrompt').value`), 'Hello かthere world');

      // 4. at the end: a new event follows the end
      await page.eval(`(() => { document.getElementById('phPrompt').blur(); window.scrollTo(0, document.documentElement.scrollHeight); return true; })()`);
      await page.eval('new Promise((r) => requestAnimationFrame(r))');
      const end = await poll(page, live, push((q) => user(q, 'Third question'), (q) => chunk(q, 'Third answer ' + 'long words '.repeat(80))));
      const stuck = await page.eval<Json>(`(() => {
        const d = document.documentElement;
        return { gap: Math.round(d.scrollHeight - (window.scrollY + innerHeight)), last: [...document.querySelectorAll('.ph-list > *')].at(-1).querySelector('.ph-text').textContent.slice(0, 12) };
      })()`);
      console.log('PHONE_REDRAW new event (at the end):', JSON.stringify(end));
      assert(Number(stuck.gap) <= 2, 'stuck to the end: ' + JSON.stringify(stuck));
      assertEquals(stuck.last, 'Third answer');
      assertEquals(page.errors, []);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone redraw: a chat list poll that changes one card keeps every card node',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      const chats = [];
      for (let i = 0; i < 6; i++) {
        chats.push(liveChat('c' + i, s.project, { breadth: { sessionInfo: { title: 'Chat ' + i } } }));
      }
      s.chats.push(...chats);
      const phone = await pairPhone(s, 'Pixel 9', SCOPES);
      const page = await phonePage(browser, s, phone);
      await page.waitFor(`document.querySelectorAll('.ph-card').length === 6`, 8000, 'six cards');
      const rev0 = await page.eval<string>('window.__aibPhone.homeRev');
      await page.eval(`(window.__cards = [...document.querySelectorAll('.ph-cw')], window.__y0 = window.scrollY, true)`);
      chats[3].breadth = { sessionInfo: { title: 'Chat 3 renamed' } };
      await page.waitFor(`window.__aibPhone.homeRev !== ${JSON.stringify(rev0)}`, 15000, 'a home poll with a change');
      await page.waitFor(`document.body.textContent.includes('Chat 3 renamed')`, 5000, 'the renamed card');
      const same = await page.eval<Json>(`(() => {
        const now = [...document.querySelectorAll('.ph-cw')];
        return { n: now.length, kept: window.__cards.filter((c) => c.isConnected).length, all: now.every((c) => window.__cards.includes(c)) };
      })()`);
      assertEquals(same, { n: 6, kept: 6, all: true });
      assertEquals(page.errors, []);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
