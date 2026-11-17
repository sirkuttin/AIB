/**
 * Phone review fixes (owner, Android Brave dark, 2026-11-16), in a headless Chrome at 412 x 915 against an in-process AIB with a fake
 * agent host:
 * 1. A chat's Subagents card follows the PC's Activity rules: named by the task's description (the type second), working and failed
 *    first, the others folded into "N finished" (closed, remembered), words Working / Done / Failed / Stopped (never "idle"), the
 *    worktree line when AIB knows it.
 * 2. The header's status says "Working · 2 subagents" while the reply has ended but subagents still run, never "Ready".
 * 3. A home card's last line is plain text: no **, `, # or list marks, a link as its text; it never starts mid-word.
 * 4. The last home card scrolls fully above + New chat.
 * AIB_DOCPAGE_SHOTS=<folder> keeps screenshots (dark).
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pairPhone } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const W = 412, H = 915;
type Json = Record<string, unknown>;

async function phoneSize(page: Page): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await page.waitFor(`document.documentElement.clientWidth === ${W} && document.documentElement.dataset.theme === "teal-dark"`, 5000, 'size');
}
const say = (seq: number, text: string, sessionId = 'sess-c1') => ({
  seq,
  kind: 'update',
  time: Date.now() / 1000 - 60,
  data: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});

/** 30 subagents as Claude Code reports them (title = the type, the task in the description): 2 running, 1 failed, 1 stopped, 26 ended. */
function thirty(): { subagents: Json; worktrees: Json } {
  const subagents: Json = {};
  const worktrees: Json = {};
  for (let i = 0; i < 26; i++) subagents[`done${i}`] = { title: 'general-purpose', description: `Check page ${i}`, state: 'idle', stopReason: 'end_turn' };
  worktrees.done0 = { where: 'Own worktree', landing: 'Merged · 3 files' };
  subagents.stop1 = { title: 'general-purpose', description: 'Rename the helpers', state: 'idle', stopReason: 'cancelled' };
  worktrees.stop1 = { where: 'Own worktree', landing: 'Stopped — ask the agent to merge it' };
  subagents.fail1 = { title: 'general-purpose', description: 'Fix the flaky test', state: 'failed' };
  worktrees.fail1 = { where: 'Own worktree', landing: "Didn't land: files it changed have uncommitted edits" };
  subagents.run1 = { title: 'Explore', description: 'Find the phone routes', state: 'running' };
  subagents.run2 = { title: 'general-purpose', description: 'Write the e2e test', state: 'running' };
  worktrees.run2 = { where: 'Own worktree', landing: 'Lands when the turn ends' };
  return { subagents, worktrees };
}

Deno.test({
  ...OPTS,
  name: 'phone review: Subagents card by the PC rules, header Working · N subagents, plain previews, last card above + New chat',
  ignore: !browserPath,
  async fn() {
    const shotsDir = Deno.env.get('AIB_DOCPAGE_SHOTS');
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      const { subagents, worktrees } = thirty();
      // c1: the reply ended, 2 subagents still run
      s.chats.push(liveChat('c1', s.project, {
        attention: { state: 'idle', needs: 0, helpers: 2, turnEndedAt: new Date(Date.now() - 30000).toISOString(), busySince: null },
        subagents,
        subagentIsolation: { on: true, reason: '', readOnly: ['Explore'] },
        subagentWorktrees: worktrees,
        events: [
          { seq: 1, kind: 'user', time: Date.now() / 1000 - 120, data: { text: 'Run the **review** fixes' } },
          say(2, '**Reply** sent. See [Storybook](studio-artifact://7ec1aa00bb11cc22) and `npm test`.'),
        ],
      }));
      // c2: the card reads only its newest events (cursor - 80): its reply starts before them, mid-word
      const long: Json[] = [];
      for (let i = 1; i <= 20; i++) long.push(say(i, 'Earlier words. ', 'sess-c2'));
      long.push(say(21, 'ark handled" button. It has **Reply** and a small **×** whose tooltip says "Mark as read". ', 'sess-c2'));
      long.push(say(22, '\n\n## Next\n- Ship the **beta** with [notes](https://example.com/notes)', 'sess-c2'));
      for (let i = 23; i <= 100; i++) long.push(say(i, ' more', 'sess-c2'));
      s.chats.push(liveChat('c2', s.project, { events: long }));
      s.chats.push(liveChat('c10', s.project, { busy: true, attention: { state: 'working', needs: 0, busySince: new Date(Date.now() - 90000).toISOString() } }));
      for (let i = 3; i <= 9; i++) s.chats.push(liveChat('c' + i, s.project));
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone, undefined, W);
      await phoneSize(page);

      // ---- 3: plain previews (and never mid-word)
      await page.waitFor(`!!document.querySelector('[data-chat="c1"] .ph-r3') && !!document.querySelector('[data-chat="c2"] .ph-r3')`, 8000, 'lines');
      const line1 = await page.eval<string>(`document.querySelector('[data-chat="c1"] .ph-r3').textContent`);
      assertEquals(line1, 'Reply sent. See Storybook and npm test.');
      const line2 = await page.eval<string>(`document.querySelector('[data-chat="c2"] .ph-r3').textContent`);
      assert(!/^ark\b/.test(line2) && !/[*`#\[\]]/.test(line2), `c2 line: ${line2}`);
      assertEquals(line2, 'It has Reply and a small × whose tooltip says "Mark as read".');

      // ---- 4: the last card scrolls fully above + New chat
      await page.eval(`window.scrollTo(0, document.documentElement.scrollHeight)`);
      await page.waitFor(`Math.abs(window.scrollY + innerHeight - document.documentElement.scrollHeight) < 2`, 3000, 'scrolled to the end');
      const gap = await page.eval<number[]>(`(() => {
        const cards = document.querySelectorAll('.ph-cw'), last = cards[cards.length - 1].getBoundingClientRect();
        const fab = document.getElementById('phNewChat').getBoundingClientRect();
        return [last.bottom, fab.top];
      })()`);
      assert(gap[0] <= gap[1] - 12 && gap[0] >= gap[1] - 24, `the last card (bottom ${gap[0]}) ends 16 px above + New chat (top ${gap[1]})`);
      await page.shot('review-home-end-dark');
      // a taller button sitting higher (bigger text, a browser's bottom toolbar): the room grows with it
      await page.eval(`(() => { const st = document.createElement('style'); st.id = 'bigFab';
        st.textContent = '.ph-fab { min-height: 90px; bottom: 70px; }'; document.head.append(st); dispatchEvent(new Event('resize')); })()`);
      await page.eval(`window.scrollTo(0, document.documentElement.scrollHeight)`);
      const gap2 = await page.eval<number[]>(`(() => {
        const cards = document.querySelectorAll('.ph-cw'), last = cards[cards.length - 1].getBoundingClientRect();
        return [last.bottom, document.getElementById('phNewChat').getBoundingClientRect().top];
      })()`);
      assert(gap2[0] <= gap2[1] - 12, `taller button: the last card (bottom ${gap2[0]}) ends above + New chat (top ${gap2[1]})`);
      await page.eval(`document.getElementById('bigFab').remove(); dispatchEvent(new Event('resize'))`);
      await page.eval(`window.scrollTo(0, 0)`);
      await page.shot('review-home-dark');

      // ---- 2: the header while the reply has ended but subagents run
      // the home header's Live chip is the same compact one-line pill: dot next to the word, not a tall box
      for (const w of [360, 412]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: H, deviceScaleFactor: 2, mobile: true });
        await page.waitFor(`document.documentElement.clientWidth === ${w}`, 5000, 'width ' + w);
        const m = await page.eval<Json>(`(() => { const c = document.querySelector('.ph-head .ph-chip'), r = c.getBoundingClientRect(), sub = document.querySelector('.ph-head .ph-sub').getBoundingClientRect();
          const rg = document.createRange(); rg.selectNodeContents(c); const t = rg.getBoundingClientRect(); const d = parseFloat(getComputedStyle(c, '::before').marginRight) + parseFloat(getComputedStyle(c, '::before').width);
          return { h: r.height, subH: sub.height, text: c.textContent, dot: d, over: r.right > innerWidth, head: document.querySelector('.ph-head').getBoundingClientRect().height }; })()`);
        assertEquals(m.text, 'Live');
        assert((m.h as number) <= (m.subH as number) + 6, 'home chip one line at ' + w + ': ' + JSON.stringify(m));
        assert((m.dot as number) <= 16 && !m.over, 'dot close to the word, in view: ' + JSON.stringify(m));
      }
      await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
      await tap(page, '[data-chat="c1"]');
      await page.waitFor(`document.getElementById('app').dataset.screen === 'chat' && !!document.querySelector('.ph-head .ph-chip')`, 8000, 'chat');
      const chip = await page.eval<string>(`document.querySelector('.ph-head .ph-chip').textContent`);
      assertEquals(chip, 'Working · 2 subagents');
      assert(await page.eval<boolean>(`document.querySelector('.ph-head .ph-chip').classList.contains('work')`), 'working colour');
      assertEquals(await page.eval<boolean>(`!document.getElementById('phSubsGo') && !document.querySelector('.ph-subs-go')`), true, 'the shortcut link is gone');
      // the header is one fixed height at 360 and 412: nothing wraps or spills, the chip is one line, the sub line shows the project
      for (const w of [360, 412]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: H, deviceScaleFactor: 2, mobile: true });
        await page.waitFor(`document.documentElement.clientWidth === ${w}`, 5000, 'width ' + w);
        const m = await page.eval<Json>(`(() => {
          const r = (q) => document.querySelector(q).getBoundingClientRect();
          const h = r('.ph-head'), chip = r('#phChip'), sub = document.querySelector('.ph-head .ph-sub'), pn = document.querySelector('.ph-head .ph-pname');
          const spill = [...document.querySelectorAll('.ph-head *')].filter((e) => { const b = e.getBoundingClientRect(); return b.bottom > h.bottom + 1 || b.top < h.top - 1 || b.right > innerWidth + 1; }).map((e) => e.className);
          return { h: h.height, chipH: chip.height, chipW: chip.width, subH: sub.getBoundingClientRect().height, pname: pn.textContent, pnW: pn.clientWidth,
            title: r('.ph-head h1').width, spill, chipText: document.getElementById('phChip').textContent, wide: document.documentElement.scrollWidth > innerWidth,
            first: document.querySelector('.ph-msg, .ph-list > *').getBoundingClientRect().top >= h.bottom - 1 };
        })()`);
        assertEquals(m.h, 56, 'header height ' + w);
        assertEquals(m.spill, [], 'nothing spills out of the header at ' + w);
        assert((m.chipH as number) <= 24, 'chip is one line at ' + w + ': ' + m.chipH);
        assert((m.subH as number) <= 20, 'sub line is one line at ' + w + ': ' + m.subH);
        assert((m.pnW as number) > 20 && m.pname !== '', 'project name shows at ' + w);
        assertEquals(m.chipText, 'Working · 2 subagents');
        assert(!m.wide, 'no sideways scroll at ' + w);
        console.log('header ' + w + ':', JSON.stringify(m));
      }
      // mid-turn the chip is plain "Working" (a span, no scroll target)
      await tap(page, '#phBack');
      await page.waitFor(`document.getElementById('app').dataset.screen === 'home'`, 5000, 'home');
      await tap(page, '[data-chat="c10"]');
      await page.waitFor(`document.getElementById('app').dataset.screen === 'chat' && !!document.querySelector('.ph-head .ph-chip')`, 8000, 'working chat');
      for (const w of [360, 412]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: H, deviceScaleFactor: 2, mobile: true });
        await page.waitFor(`document.documentElement.clientWidth === ${w}`, 5000, 'width ' + w);
        const m = await page.eval<Json>(`(() => { const h = document.querySelector('.ph-head').getBoundingClientRect(), c = document.querySelector('.ph-head .ph-chip').getBoundingClientRect(), pn = document.querySelector('.ph-head .ph-pname');
          return { h: h.height, chipH: c.height, chipText: document.querySelector('.ph-head .ph-chip').textContent, pn: pn.clientWidth, over: [...document.querySelectorAll('.ph-head *')].some((e) => e.getBoundingClientRect().right > innerWidth + 1) }; })()`);
        assertEquals(m.h, 56);
        assert((m.chipH as number) <= 24 && /^Working/.test(String(m.chipText)) && !/subagent/.test(String(m.chipText)), 'mid-turn chip: ' + JSON.stringify(m));
        assert((m.pn as number) > 20 && !m.over, 'project name shows, no overflow: ' + JSON.stringify(m));
      }
      await tap(page, '#phBack');
      await page.waitFor(`document.getElementById('app').dataset.screen === 'home'`, 5000, 'home');
      await tap(page, '[data-chat="c1"]');
      await page.waitFor(`!!document.getElementById('phChip')`, 8000, 'chat c1');
      await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
      const fits = await page.eval<boolean>(`(() => { const d = document.documentElement; return d.scrollWidth <= d.clientWidth; })()`);
      assert(fits, 'no sideways scroll with the longer chip');
      await page.shot('review-chat-header-dark');

      // ---- 1: the Subagents card
      await tap(page, '#phChip');
      await page.waitFor(`!!document.querySelector('#phSubs .ph-sub-list')`, 5000, 'subagents open');
      assert(await page.eval<boolean>(`(() => { const t = document.getElementById('phSubs').getBoundingClientRect().top; return t >= 0 && t < innerHeight; })()`), 'the chip scrolled to the Subagents card');
      const head = await page.eval<string>(`document.querySelector('#phSubs > .ph-fold').textContent`);
      assertEquals(head, '⑂Subagents · 2 working · 1 failed›');
      const rows = () =>
        page.eval<string[][]>(`[...document.querySelectorAll('#phSubs li[data-sub]')].map((li) => [
          li.querySelector('.ph-sub-title').textContent, (li.querySelector('.ph-sub-meta') || {}).textContent || '', li.querySelector('.ph-sw').textContent])`);
      assertEquals(await rows(), [
        ['Write the e2e test', 'general-purpose · Own worktree · Lands when the turn ends', 'Working'],
        ['Find the phone routes', 'Explore · In your folder (read-only)', 'Working'],
        ['Fix the flaky test', "Own worktree · Didn't land: files it changed have uncommitted edits", 'Failed'],
      ]);
      assertEquals(await page.eval<string>(`document.getElementById('phSubsDone').textContent`), '▸27 finished');
      assertEquals(await page.eval<string>(`document.getElementById('phSubsDone').getAttribute('aria-expanded')`), 'false');
      await page.shot('review-subagents-dark');
      await tap(page, '#phSubsDone');
      await page.waitFor(`document.querySelectorAll('#phSubs li[data-sub]').length === 30`, 5000, 'finished open');
      const all = await rows();
      assertEquals(all[3], ['Rename the helpers', 'Own worktree · Stopped — ask the agent to merge it', 'Stopped']);
      assert(all.some((r) => r[0] === 'Check page 0' && r[1] === 'Own worktree · Merged · 3 files' && r[2] === 'Done'), 'merged line');
      assert(!all.some((r) => /idle/i.test(r.join(' '))), 'never idle');
      assert(all.some((r) => r[0] === 'Check page 5' && r[1] === ''), 'a finished one without a worktree line is one line');
      assert(all.slice(3).every((r) => r[2] === 'Done' || r[2] === 'Stopped'), 'finished words');
      await page.eval(`document.getElementById('phSubsDone').scrollIntoView({ block: 'start' })`);
      await page.shot('review-subagents-finished-dark');
      // remembered on this phone: open again after leaving the chat
      await tap(page, '#phBack');
      await page.waitFor(`document.getElementById('app').dataset.screen === 'home'`, 5000, 'home');
      await tap(page, '[data-chat="c1"]');
      await page.waitFor(`!!document.getElementById('phChip')`, 8000, 'chat again');
      await tap(page, '#phChip');
      await page.waitFor(`document.querySelectorAll('#phSubs li[data-sub]').length === 30`, 5000, 'still open');
      if (shotsDir) console.log('screenshots in', shotsDir);
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
