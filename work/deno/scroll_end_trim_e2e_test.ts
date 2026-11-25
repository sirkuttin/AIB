/**
 * Reading down a long chat to its end: the step that reaches the end follows again, and that same moment the page drops the older
 * rows it kept for reading (ROWS_KEEP: a following list keeps its newest 500). Taking rows out makes the browser clamp scrollTop;
 * the scroll controller read that clamp as a scroll of yours, so the list left "following" and the view jumped (the end was
 * left, the rows came back, you sat ~2,000 px above the newest message). Seen as an intermittent "the list jumped on the way
 * down" in perf_reading_e2e_test.ts, whenever the poll that trims landed with the wheel step that reached the end.
 *
 * Guards: after wheeling to the end of a long chat read far up and a pause long enough for every poll, the list is following,
 * sits at the very end (gap <= 2), the newest row is in view, and it stays so for a further second. Also with a slow main thread
 * (CPU throttled) so the redraw and the scroll land close together.
 *
 * Run (from app):  deno test -A ../../work/deno/scroll_end_trim_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert } from './_assert.ts';
import { anchor, browserPath, Lab, m, sleep } from './_scroll_lab.ts';
import { openLongChat } from './_perf_lab.ts';

Deno.test({
  name: 'reading down to the end of a long chat: following again at the end, not thrown off it when the old rows are dropped',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open();
    try {
      const page = lab.page;
      await openLongChat(lab, 1200, 0);
      await sleep(1000);
      const wheelNow = async (dy: number) => {
        const [x, y] = await page.eval<[number, number]>(`(() => { const r = document.getElementById('messages').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
      };
      // up: far enough that the list reads a window of the chat, not the end
      for (let i = 0; i < 40; i++) {
        await wheelNow(-12000);
        await sleep(120);
      }
      await sleep(1000);
      const far = await m(page);
      assert(far.paused && far.gap > 5000, `reading far up: ${JSON.stringify(far)}`);
      await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });

      // down, wheel by wheel, to the end (the step that reaches it follows)
      let reached = false;
      for (let i = 0; i < 400 && !reached; i++) {
        await wheelNow(900);
        await sleep(150);
        reached = !(await m(page)).paused;
      }
      assert(reached, `the wheel reached the end and followed: ${JSON.stringify(await m(page))}`);
      // now the polls run: older rows are dropped from the following list; for 6 s it must stay at the end
      for (let t = 0; t < 12; t++) {
        await sleep(500);
        const x = await m(page);
        const a = await anchor(page);
        assert(!x.paused && x.gap <= 2, `after ${(t + 1) * 500} ms the list was thrown off the end: ${JSON.stringify(x)} first row ${JSON.stringify(a)}`);
        assert(x.lastBottom <= x.client + 2 && x.lastBottom > 0, `the newest row is in view: ${JSON.stringify(x)}`);
      }
      await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const end = await m(page);
      assert(end.lastText.includes('PERFSEEDEND'), `the newest row is drawn at the end: "${end.lastText}"`);
      assert(end.rows <= 700, `the older rows were dropped once following (${end.rows} drawn)`);
    } finally {
      await lab.close();
    }
  },
});
