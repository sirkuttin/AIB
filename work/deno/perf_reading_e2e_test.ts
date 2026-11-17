/**
 * A long chat read far up, end to end (the perf lab: a real Studio, the scripted agent, headless Chrome, no window): 2,500 agent
 * messages with steps (~5,000 rows) and 15 helpers, turn open. You wheel up through the history, then sit there, then wheel back
 * down to the end. Before the fix the drawn window only ever grew while you read: 3,000 rows, ~190k DOM nodes and ~6,000 listeners,
 * and the page used ~4.6% of a core doing nothing (style recalcs and layouts over all of it; over 5% on a slower PC).
 *
 * Guards: the drawn rows stay a window (DRAW_MAX) all the way up; DOM nodes in the page stay low; idle CPU < 5% far up; on the
 * way back down the row at the top moves by exactly your wheel while rows are drawn in below it (no jumps); reaching the end
 * follows again; nothing writes the list's scrollTop outside scroll-controller.js.
 *
 * Run (from outputs/agent-studio):  deno test -A ../../work/deno/perf_reading_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert } from './_assert.ts';
import { anchor, browserPath, Lab, m, ownerProblems, sleep, wheel, whereIs } from './_scroll_lab.ts';
import { metrics, openLongChat, sampleFor } from './_perf_lab.ts';

const DRAWN_MAX = 700; // chat.js DRAW_MAX (500) + a step drawn below + rows the place keeps; before: 3000

Deno.test({
  name: 'a long chat read far up: the drawn rows stay a window, nodes and idle CPU stay low, no jumps on the way back down',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open();
    try {
      const page = lab.page;
      await openLongChat(lab, 2500, 15);
      await sleep(2000);
      const drawn = () => page.eval<number>(`document.getElementById('messages').children.length`);
      const firstText = () => page.eval<string>(`document.getElementById('messages').firstElementChild?.textContent.slice(0, 80) || ''`);
      await page.send('Performance.enable', { timeDomain: 'timeTicks' });

      // up: far into the history (past the first 3,000 rows the old window drew)
      let most = 0;
      const t0 = Date.now();
      for (let i = 0; i < 260 && Date.now() - t0 < 150_000; i++) {
        await wheel(page, -4000);
        if (i % 10 === 0) most = Math.max(most, await drawn());
      }
      await sleep(1500);
      most = Math.max(most, await drawn());
      const up = await metrics(page);
      const top = await firstText();
      const live = await page.eval<number>(`(() => { const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); let n = 0; while (w.nextNode()) n++; return n; })()`);
      console.log(`far up: ${await drawn()} rows drawn (most ${most}), ${live} nodes in the page (${up.Nodes} with detached ones), ${up.JSEventListeners} listeners; first row "${top.slice(0, 40)}"`);
      const n = Number((top.match(/(?:History message|step) (\d+)/) || [])[1]);
      assert(n < 1500, `read far up (past the 3,000 rows the old window drew): first row "${top}"`);
      assert(most <= DRAWN_MAX, `${most} rows drawn while reading up (want <= ${DRAWN_MAX})`);
      assert(live < 50_000, `${live} DOM nodes in the page far up (before: ~190,000)`);

      // sit there
      const idle = await sampleFor(page, 20, 10, (s) => console.log('idle far up', JSON.stringify(s)));
      const idleCpu = Math.max(...idle.map((s) => s.cpu));
      assert(idleCpu < 5, `idle far up: ${idleCpu}% of a core (want < 5%)`);

      // back down: each wheel moves the row at the top by exactly the wheel while rows are drawn in below it
      const STEP = 900;
      const jumps: string[] = [];
      let reachedEnd = false;
      for (let i = 0; i < 700 && !reachedEnd; i++) {
        const a = await anchor(page);
        await wheel(page, STEP);
        await sleep(40);
        const now = a ? await whereIs(page, a.text) : null;
        const x = await m(page);
        // while you still read (the step that reaches the end follows: the list then keeps its newest row at the bottom)
        if (x.paused && a && now !== null && x.gap > 2 && Math.abs(now - (a.off - STEP)) > 2) jumps.push(`step ${i}: "${a.text.slice(0, 50)}" ${a.off} -> ${now}`);
        reachedEnd = !x.paused;
      }
      const end = await m(page);
      console.log(`back down: ${end.rows} rows drawn, following ${!end.paused}, jumps ${jumps.length}`);
      assert(jumps.length === 0, `the list jumped on the way down: ${jumps.slice(0, 5).join(' | ')}`);
      assert(reachedEnd, `scrolling to the end follows again: ${JSON.stringify(end)}`);
      assert(end.lastText.includes('PERFSEEDEND'), `the newest row is drawn at the end: "${end.lastText}"`);
      const owner = await ownerProblems(page);
      assert(!owner, owner);
      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
    } finally {
      await lab.close();
    }
  },
});
