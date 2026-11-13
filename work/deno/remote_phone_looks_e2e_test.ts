/**
 * Phone page v2 looks (QA round 2026-11-12) in a headless Chrome at phone widths against an in-process AIB with a fake agent host:
 * header heights, the project name never clipped, surfaces on the raised colour with grey folds, sheets (panel, radius 22, shadow,
 * grab 36 x 5, rows 52 px), the Undo toast above + New chat, + New chat pinned bottom-right (also on an empty list), New chat
 * pills and rows, working = amber, no sideways scroll at 320 / 375 / 390 px, 44 px tap targets.
 * AIB_DOCPAGE_SHOTS=<folder> keeps screenshots (light and dark); AIB_LOOKS_BEFORE=1 only takes them (no checks), to compare an old build.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pairPhone } from './_remote_fixture.ts';
import { setAgentRows } from '../../outputs/agent-studio/server/remote/newchat.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const BEFORE = Deno.env.get('AIB_LOOKS_BEFORE') === '1';
const ok = (cond: unknown, message: string) => {
  if (!BEFORE) assert(cond, message);
};
const same = (actual: unknown, expected: unknown, message: string) => {
  if (!BEFORE) assertEquals(actual, expected, message);
};
const NO_SIDEWAYS =
  `(() => { const d = document.documentElement; return d.scrollWidth <= d.clientWidth && document.body.scrollWidth <= d.clientWidth; })()`;
const WIDTHS = `(() => { const d = document.documentElement; return [d.scrollWidth, d.clientWidth]; })()`;

async function size(page: Page, width: number): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 2, mobile: true });
  await page.waitFor(`document.documentElement.clientWidth === ${width}`, 5000, `width ${width}`);
}
async function scheme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  await page.waitFor(`document.documentElement.dataset.theme === "teal-${value}"`, 5000, value);
}
async function sideways(page: Page, where: string): Promise<void> {
  ok(await page.eval(NO_SIDEWAYS), `${where}: sideways scroll ${await page.eval(WIDTHS)}`);
}
/** Every visible tap target of these kinds is at least 44 px each way. */
async function targets(page: Page, selector: string, where: string): Promise<void> {
  const small = await page.eval<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.offsetParent || getComputedStyle(e).position === 'fixed')
    .map((e) => [e.className || e.id, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])
    .filter(([, w, h]) => w < 44 || h < 44).map((x) => x.join(' '))`,
  );
  ok(small.length === 0, `${where}: tap targets under 44 px: ${small}`);
}
const rect = (page: Page, selector: string) =>
  page.eval<{ x: number; y: number; w: number; h: number; r: number; b: number }>(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`,
  );
/** The colour a token resolves to, as the browser paints it (rgb). */
const token = (page: Page, name: string) =>
  page.eval<string>(
    `(() => { const p = document.createElement('i'); document.body.append(p);
      p.style.color = getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)});
      const c = getComputedStyle(p).color; p.remove(); return c; })()`,
  );
const css = (page: Page, selector: string, prop: string) =>
  page.eval<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${prop}`);

const LONG = 'x'.repeat(80);
const ASK = {
  toolCall: { title: 'Run the tests', rawInput: { command: 'npm test ' + LONG } },
  options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
};

Deno.test({
  ...OPTS,
  name:
    'phone page looks: header 56 / 68 px, surfaces, sheets, toast above + New chat, + New chat pinned, New chat pills, tap targets, no sideways scroll at 320 / 375 / 390',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      s.chats.push(liveChat('c1', s.project, {
        busy: true,
        attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date(Date.now() - 5000).toISOString() },
        subagents: { a: { title: 'Codex tests', state: 'running' }, b: { title: 'Claude api', state: 'completed' } },
        events: [{ seq: 1, kind: 'user', time: Date.now() / 1000 - 30, data: { text: 'Fix the checkout' } }],
      }));
      s.chats.push(liveChat('c2', s.project, {
        attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null },
        permissions: [{ key: 'perm1', params: ASK }],
        events: [
          { seq: 1, kind: 'user', time: Date.now() / 1000 - 90, data: { text: 'Run the tests' } },
          { seq: 2, kind: 'permission', time: Date.now() / 1000 - 80, data: { key: 'perm1', params: ASK } },
        ],
      }));
      s.chats.push(liveChat('c3', s.project));
      s.saveChat({ sessionId: 'old-1', prompt: 'Export the invoices', reply: 'Done.', ageSeconds: 86400 });
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);
      const shots = async (name: string) => {
        for (const mode of ['light', 'dark'] as const) {
          await scheme(page, mode);
          await page.shot(`${name}-${mode}`);
        }
        await scheme(page, 'light');
      };
      await scheme(page, 'light');

      // ---- home at 320 / 375 / 390
      for (const w of [320, 375, 390]) {
        await size(page, w);
        await sideways(page, `home ${w}`);
        const head = await rect(page, '.ph-head');
        ok(head.h >= 56 && head.h <= 58, `home header ${w}: ${head.h} px`);
        const sub = await rect(page, '.ph-head .ph-sub');
        ok(sub.h <= 22, `home subtitle ${w}: ${sub.h} px tall`);
        same(await css(page, '.ph-head .ph-sub', 'fontSize'), '13px', 'subtitle size');
        const cut = await page.eval<boolean>(`[...document.querySelectorAll('.ph-card .ph-pname')].some((n) => n.scrollWidth > n.clientWidth + 1)`);
        ok(!cut, `a project name is clipped on a card at ${w}`);
      }
      await size(page, 375);
      await targets(page, '.ph-head button, .ph-fab, .ph-more-btn, .ph-fb', 'home');

      // surfaces: the raised colour, not the page's beige; the filter bar is a band; + New chat bottom-right
      const panel2 = await token(page, '--panel-2');
      const hover = await token(page, '--hover');
      same(await css(page, '.ph-card:not(.nr)', 'backgroundColor'), panel2, 'card surface');
      same(await css(page, '.ph-fb', 'backgroundColor'), panel2, 'filter button surface');
      same(await css(page, '.ph-filter', 'borderBottomWidth'), '1px', 'filter band border');
      const filter = await rect(page, '.ph-filter');
      ok(filter.x === 0 && filter.w === 375, `the filter band is full width ${filter.x} ${filter.w}`);
      const fab = await rect(page, '#phNewChat');
      ok(Math.abs(fab.h - 56) < 1 && Math.abs(375 - fab.r - 16) < 1 && Math.abs(812 - fab.b - 16) < 1, `FAB ${JSON.stringify(fab)}`);
      same(await css(page, '#phNewChat', 'borderTopLeftRadius'), '18px', 'FAB radius');
      same(await css(page, '#phNewChat', 'fontWeight'), '700', 'FAB weight');
      await shots('home');

      // ---- the card menu: panel colour, radius 22, shadow, grab 36 x 5, rows 52 px with radius 12, a dark scrim
      await tap(page, '[data-menu-for="l:c3"]');
      await page.waitFor('!!document.getElementById("phMenu")', 5000, 'card menu');
      same(await css(page, '#phMenu .ph-menu', 'backgroundColor'), await token(page, '--panel'), 'sheet colour');
      same(await css(page, '#phMenu .ph-menu', 'borderTopLeftRadius'), '22px', 'sheet radius');
      ok((await css(page, '#phMenu .ph-menu', 'boxShadow')) !== 'none', 'sheet shadow');
      const grab = await rect(page, '#phMenu .ph-grab');
      ok(grab.w === 36 && grab.h === 5, `grab ${grab.w} x ${grab.h}`);
      const row = await rect(page, '#phMenu .ph-mi');
      ok(row.h === 52, `menu row ${row.h}`);
      same(await css(page, '#phMenu .ph-mi', 'borderTopLeftRadius'), '12px', 'row radius');
      const scrim = await css(page, '#phMenu .ph-shade', 'backgroundColor');
      ok(/0\.5\)$/.test(scrim), `the scrim dims with ink at 50%: ${scrim}`);
      const gap = await page.eval<number>(
        `(() => { const m = document.querySelector('#phMenu .ph-mh span'); const d = m.firstElementChild.getBoundingClientRect();
          const n = m.children[1] ? m.children[1].getBoundingClientRect() : null; return n ? n.left - d.right : 99; })()`,
      );
      ok(gap >= 5 && gap < 99, `a gap after the project mark in the sheet header ${gap}`);
      await sideways(page, 'card menu');
      await targets(page, '#phMenu .ph-mi', 'card menu');
      await shots('card-menu');
      await page.eval('document.querySelector("#phMenu .ph-shade").click()');

      // ---- the Undo toast sits above + New chat; Undo is 44 px
      await tap(page, '[data-menu-for="l:c3"]');
      await page.click('#phMenu [data-mi="archive"]');
      await page.waitFor('!!document.querySelector("#phMenu [data-how=keep]")', 5000, 'the two choices');
      await page.click('#phMenu [data-how="keep"]');
      await page.waitFor('!!document.getElementById("phUndo")', 15000, 'archived, Undo');
      const toast = await rect(page, '#phToast');
      const fab2 = await rect(page, '#phNewChat');
      ok(toast.b <= fab2.y - 8, `the toast (bottom ${toast.b}) clears + New chat (top ${fab2.y})`);
      const undo = await rect(page, '#phUndo');
      ok(undo.h >= 44 && undo.w >= 44, `Undo ${undo.w} x ${undo.h}`);
      await shots('home-undo');
      await page.click('#phUndo');
      await page.waitFor('!!document.querySelector(\'[data-chat="c3"]\')', 15000, 'back');

      // ---- the working chat: header 68 px with the subagents line at every width, amber dots, grey folds
      await tap(page, '.ph-card[data-chat="c1"]');
      await page.waitFor('!!document.getElementById("phSubsGo")', 15000, 'the chat');
      for (const w of [320, 375, 390]) {
        await size(page, w);
        const head = await rect(page, '.ph-head');
        ok(head.h >= 66 && head.h <= 70, `chat header ${w}: ${head.h} px`);
        const sub = await rect(page, '.ph-head .ph-sub');
        ok(sub.h <= 22, `chat subtitle ${w}: ${sub.h} px tall`);
        const cut = await page.eval<boolean>(`[...document.querySelectorAll('.ph-head .ph-pname')].some((n) => n.scrollWidth > n.clientWidth + 1)`);
        ok(!cut, `the project name is clipped in the chat header at ${w}: ${await page.eval('[...document.querySelectorAll(".ph-head .ph-pname")].map((n) => n.textContent + " " + n.scrollWidth + "/" + n.clientWidth + " tt " + n.closest(".ph-tt").clientWidth).join()')}`);
        await sideways(page, `chat ${w}`);
      }
      await size(page, 375);
      await page.eval('document.getElementById("phSubsGo").click()');
      await page.waitFor('document.querySelectorAll("#phSubs li .ph-dot").length === 2', 15000, 'subagents');
      const work = await token(page, '--hd-work');
      same(await css(page, '#phSubs li .ph-dot.work', 'backgroundColor'), work, 'working subagent dot');
      if (await page.eval('!!document.querySelector(".ph-live .ph-spin")')) {
        same(await css(page, '.ph-live .ph-spin', 'borderTopColor'), work, 'spinner');
        same(await css(page, '.ph-live', 'color'), work, 'live line');
      }
      same(await css(page, '#phSubs', 'backgroundColor'), hover, 'the Subagents fold');
      ok(hover !== (await token(page, '--bg')), 'folds are visibly grey against the page');
      await targets(page, '.ph-head button, .ph-send, .ph-fold, .ph-subrow', 'chat');
      await shots('chat');

      // ---- the approval card on the raised colour; Deny is raised too
      await page.click('#phBack');
      await tap(page, '.ph-card[data-chat="c2"]');
      await page.waitFor('!!document.querySelector(".ph-req")', 15000, 'the approval');
      if (!(await page.eval('!!document.querySelector(".ph-req.open")'))) await page.eval('document.querySelector(".ph-req-head").click()');
      await page.waitFor('!!document.querySelector(".ph-req.open .ph-btn.deny")', 5000, 'open');
      same(await css(page, '.ph-req.open', 'backgroundColor'), panel2, 'approval card');
      same(await css(page, '.ph-btn.deny', 'backgroundColor'), panel2, 'Deny');
      await targets(page, '.ph-req.open .ph-btn, .ph-send', 'approval');
      await sideways(page, 'approval');
      await shots('chat-approval');
      await page.click('#phBack');

      // ---- New chat: soft accent wash + 1 px accent border, radius 12, 15 px / 650, gap 6; chosen project 54 px
      await tap(page, '#phNewChat');
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "new" && !!document.querySelector(".ph-pick[data-project]")',
        15000,
        'projects',
      );
      await shots('new-project');
      await tap(page, `.ph-pick[data-project="${s.projectId}"]`);
      await page.waitFor('!!document.querySelector(\'.ph-pick[data-agent="claude"]\')', 15000, 'agents');
      await page.click('.ph-pick[data-agent="claude"]');
      await page.waitFor('!!document.querySelector(".ph-pill[data-mode]")', 15000, 'pills');
      await page.click('.ph-pill[data-mode="bypassPermissions"]');
      const chosen = await rect(page, '.ph-chosen');
      ok(chosen.h >= 53 && chosen.h <= 56, `chosen project row ${chosen.h}`);
      same(await css(page, '.ph-pills', 'columnGap'), '6px', 'pill gap');
      const on = '.ph-pill[aria-pressed="true"]';
      same(await css(page, on, 'borderTopLeftRadius'), '12px', 'pill radius');
      same(await css(page, on, 'fontSize'), '15px', 'pill size');
      same(await css(page, on, 'fontWeight'), '650', 'pill weight');
      same(await css(page, on, 'backgroundColor'), await token(page, '--accent-wash'), 'pill wash');
      same(await css(page, on, 'borderTopColor'), await token(page, '--accent'), 'pill border');
      same(await css(page, '.ph-pick[aria-pressed="true"]', 'backgroundColor'), await token(page, '--accent-wash'), 'picked agent row');
      same(await css(page, '.ph-pill small', 'opacity'), '1', 'default caption is not faded');
      await targets(page, '.ph-pill, .ph-pick, #phNewStart', 'new chat');
      await sideways(page, 'new chat');
      await shots('new-chat');
      for (const w of [320, 390]) {
        await size(page, w);
        await sideways(page, `new chat ${w}`);
      }
      await size(page, 375);
      same(page.errors, [], 'console errors');
      await page.close();
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone page looks: on an empty list + New chat is still pinned to the bottom-right corner',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone, undefined, 375, false);
      await page.waitFor('!!document.getElementById("phNewChat")', 15000, '+ New chat');
      const fab = await rect(page, '#phNewChat');
      ok(Math.abs(375 - fab.r - 16) < 1 && Math.abs(812 - fab.b - 16) < 1 && fab.h === 56, `FAB on an empty list ${JSON.stringify(fab)}`);
      for (const w of [320, 375, 390]) {
        await size(page, w);
        await sideways(page, `empty home ${w}`);
      }
      await size(page, 375);
      await page.shot('home-empty-light');
      await page.close();
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
