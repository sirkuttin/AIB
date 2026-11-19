/**
 * The fixes of the project right panel code review (aib-shared/reviews/project-right-panel-code-review.md), in the real page. A real
 * Studio (the scroll lab: temp state folder, free port; never the live ports), the scripted agent, headless Chrome or Edge.
 *
 *   S1  An expanded idle chat is read once, not at the poll pace; "Show N more" reads a few idle chats at a time.
 *   S4  Every idle chat has the same neutral dot, never the sidebar's amber needs-you dot.
 *   M3  The Artifacts list is not polled while another tab shows; it is read when any chat's turn ends and when the window gets focus.
 *   S5  A widened panel keeps its width over tab switches (a doc opening in Docs, Activity) and a project switch, until the owner
 *       narrows it or drags the edge.
 *   M2  The Docs tab of a project's New chat page lists that project's docs, and "+ New doc" makes the doc in that project.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/project_panel_review_fixes_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, type Page, settle, shown } from './_scroll_lab.ts';

type Json = Record<string, unknown>;

function panelTest(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1600, 900);
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
      } finally {
        await lab.close();
      }
    },
  });
}

/** A working chat (its turn stays open until `end()`), saying `end` and running the helpers given. */
async function working(lab: Lab, end: string, list: [string, string][] = []) {
  const c = await lab.chat();
  await c.start();
  c.say(`Here ${end}`);
  list.forEach(([desc, state], i) =>
    c.step({ u: { sessionUpdate: 'subagent_update', subagent: { sessionId: `${end.toLowerCase()}-helper-${i}`, description: desc, state } } })
  );
  return c;
}
/** An idle chat: one turn saying `end`, the helpers given, then the turn ends. */
async function idleChat(lab: Lab, end: string, list: [string, string][] = []) {
  const c = await working(lab, end, list);
  c.end();
  return c;
}
async function joined(page: Page, c: Chat) {
  await page.waitFor(`!!document.querySelector(${JSON.stringify(`#projectActivity > .sp-grp[data-key=${JSON.stringify(c.key)}]`)})`, 20000, `${c.key} joined`);
}
const IDLE_SEC = (key: string) => `#projectActivity > .sp-idle-list > .sp-idle[data-key=${JSON.stringify(key)}]`;
const IDLES = `(() => {
  const list = document.querySelector('#projectActivity > .sp-idle-list');
  const g = list ? [...list.querySelectorAll(':scope > .sp-idle')] : [];
  const vis = (n) => !!n && n.getClientRects().length > 0;
  const more = list?.querySelector(':scope > .sp-idle-more');
  return { keys: g.map((n) => n.dataset.key),
    heads: g.map((n) => { const h = n.querySelector('.sp-ihead'); return [h.querySelector('.sp-caret').textContent, h.querySelector('.sp-count').textContent, h.querySelector('.sp-agent').textContent, h.disabled ? 'off' : 'on'].join('|'); }),
    open: g.filter((n) => vis(n.querySelector('.sp-idle-body'))).map((n) => n.dataset.key),
    titles: g.map((n) => [...n.querySelectorAll('.sp-idle-body .subagent-card')].filter(vis).map((c) => c.querySelector('.sa-title')?.textContent || '')),
    more: vis(more) ? more.textContent : '' };
})()`;
type Idles = { keys: string[]; heads: string[]; open: string[]; titles: string[][]; more: string };
const idles = (page: Page) => page.eval<Idles>(IDLES);
async function waitIdle(page: Page, test: string, what: string) {
  await page.waitFor(`(() => { const i = ${IDLES}; return ${test}; })()`, 20000, what).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await idles(page))}`);
  });
}
/** The page's requests (resource timing) whose URL matches. */
const requests = (page: Page, test: string) =>
  page.eval<number>(`performance.getEntriesByType('resource').filter((e) => { const n = decodeURIComponent(e.name); return ${test}; }).length`);

panelTest('S4: every idle chat has the same neutral hollow dot, never the sidebar\'s amber needs-you dot', async (lab) => {
  const page = lab.page;
  const w = await working(lab, 'WORKEND', [['Find rounding bug', 'running']]);
  await lab.select(w);
  await joined(page, w);
  await idleChat(lab, 'ONEEND', [['First helper', 'completed']]);
  await idleChat(lab, 'TWOEND');
  await waitIdle(page, 'i.keys.length === 2', 'two idle chats');
  // even when the sidebar would show a needs-you dot for them
  await page.eval(`(() => { const o = AgentWorkspaceUI.dotForKey; AgentWorkspaceUI.dotForKey = (k) => { const d = o(k) || document.createElement('i'); d.className = 'status-dot st-needs_you'; return d; }; })()`);
  await settle(2200);
  const dots = await page.eval<string[]>(`[...document.querySelectorAll('#projectActivity .sp-ihead > .sp-dot')].map((d) => d.className)`);
  assertEquals(dots.length, 2);
  for (const d of dots) assert(/\bst-idle\b/.test(d) && !/needs|unread|working/.test(d), `a neutral idle dot: ${d}`);
  assertEquals(new Set(dots).size, 1, 'the same dot for every idle chat');
  w.end();
});

panelTest('S1: an expanded idle chat is read once, not at the poll pace', async (lab) => {
  const page = lab.page;
  const w = await working(lab, 'WORKEND', [['Find rounding bug', 'running']]);
  await lab.select(w);
  await joined(page, w);
  const done = await idleChat(lab, 'DONEEND', [['Port the parser', 'completed'], ['Check the docs', 'completed']]);
  await waitIdle(page, `i.heads[0] === '▸|2 finished|Claude Code|on'`, 'done: caret and "2 finished"');
  await page.click(`${IDLE_SEC(done.key)} .sp-ihead`);
  await waitIdle(page, `i.open.length === 1 && i.titles[0].length === 2`, 'expanded');
  await settle(3500); // its read on expanding is done
  const mine = `(n.includes(${JSON.stringify(done.id)}) || n.includes(${JSON.stringify(done.sid)}))`;
  const base = await requests(page, mine);
  assert(base > 0, 'it was read at least once');
  await settle(14000); // longer than several poll periods (1.5 s to 5 s)
  assertEquals(await requests(page, mine), base, 'an expanded idle chat is not re-read while it stays idle');
  w.end();
});

panelTest('S1: "Show N more" reads a few idle chats at a time, not all at once, and never again at the poll pace', async (lab) => {
  const page = lab.page;
  const w = await working(lab, 'WORKEND');
  for (let n = 0; n < 30; n++) {
    const s = lab.savedChat(`lazy-saved-${n}`);
    s.user(`Question ${n}`);
    s.say(`Answer ${n}`);
  }
  await lab.select(w);
  await joined(page, w);
  await waitIdle(page, `i.keys.length === 10 && i.more === 'Show 20 more'`, 'ten idle chats and "Show 20 more"');
  const read = `(() => { const seen = new Set(); for (const e of performance.getEntriesByType('resource')) { const m = /lazy-saved-(\\d+)/.exec(decodeURIComponent(e.name)); if (m && /\\/api\\/(agents|commands)/.test(decodeURIComponent(e.name))) seen.add(m[1]); } return seen.size; })()`;
  await page.waitFor(`${read} === 10`, 60000, 'the ten shown chats are read (three at a time)');
  await settle(3000);
  const before = await page.eval<number>(read);
  assertEquals(before, 10, 'only the shown chats are read');
  await page.click('#projectActivity > .sp-idle-list > .sp-idle-more');
  await waitIdle(page, `i.keys.length === 30 && i.more === ''`, 'all thirty listed');
  await settle(400);
  const burst = (await page.eval<number>(read)) - before;
  assert(burst <= 3, `a few more chats are read right after "Show 20 more", not 20 at once: ${burst}`);
  await page.waitFor(`${read} === 30`, 90000, 'every idle chat is counted in the end');
  const all = `/lazy-saved-/.test(n) && /\\/api\\/(agents|commands)/.test(n)`;
  await settle(2000);
  const counted = await requests(page, all);
  await settle(12000);
  assertEquals(await requests(page, all), counted, 'idle chats already counted are not read again');
  w.end();
});

panelTest('M3: the Artifacts list is not polled while another tab shows; it is read at a turn end and on window focus, and polled (10 s) only while its tab shows', async (lab) => {
  const page = lab.page;
  const a = await working(lab, 'ALPHAEND');
  await lab.select(a);
  await joined(page, a);
  const b = await working(lab, 'BETAEND');
  await joined(page, b);
  const list = `n.includes('/api/live/project/artifacts')`;
  await page.waitFor(`performance.getEntriesByType('resource').some((e) => e.name.includes('/api/live/project/artifacts'))`, 20000, 'the first read');
  await settle(1500);
  const idle = await requests(page, list);
  await settle(26000); // 2.5 periods of the 10 s poll, 8 of the old 3 s one
  assertEquals(await requests(page, list), idle, 'no read in 26 s while the Activity tab shows');
  // a turn that ends in any chat of the project: one read
  b.end();
  await page.waitFor(`(${`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/live/project/artifacts')).length`}) > ${idle}`, 20000, 'a read at the turn end');
  await settle(1500);
  // window focus: one read
  const afterTurn = await requests(page, list);
  await page.eval(`window.dispatchEvent(new Event('focus'))`);
  await page.waitFor(`(${`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/live/project/artifacts')).length`}) > ${afterTurn}`, 10000, 'a read on window focus');
  // the Artifacts tab shows: a read at once and every 10 s
  await page.click('#paneTab-artifacts');
  await settle(1500);
  const shownAt = await requests(page, list);
  assert(shownAt > afterTurn, 'a read on showing the tab');
  await settle(11500);
  const polled = await requests(page, list);
  assert(polled > shownAt && polled - shownAt <= 2, `polled about every 10 s while it shows: ${polled - shownAt} in 11.5 s`);
  // leaving the tab stops it again
  await page.click('#paneTab-activity');
  await settle(1500);
  const left = await requests(page, list);
  await settle(12000);
  assertEquals(await requests(page, list), left, 'no read after leaving the tab');
  a.end();
});

panelTest('S5: a widened panel keeps its width over tab switches and an opened doc; only the owner narrows it', async (lab) => {
  const page = lab.page;
  const a = await working(lab, 'ALPHAEND');
  await lab.select(a);
  await joined(page, a);
  const width = () => page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`);
  const narrow = await width();
  await page.click('#paneTab-changes');
  await page.click('#paneTabs .pane-expand');
  await page.waitFor(`document.body.classList.contains('changes-wide')`, 10000, 'widened');
  await settle(500);
  const wide = await width();
  assert(wide > narrow + 100, `widened: ${narrow} -> ${wide}`);
  for (const tab of ['docs', 'activity', 'artifacts', 'docs', 'changes']) {
    await page.click(`#paneTab-${tab}`);
    await settle(400);
    assertEquals(await width(), wide, `the width stays on ${tab}`);
    assert(await page.eval<boolean>(`document.body.classList.contains('changes-wide')`), `still widened on ${tab}`);
  }
  // the widen button is still there on every tab, to narrow it
  await page.click('#paneTab-docs');
  assert(await page.eval<boolean>(`!document.querySelector('#paneTabs .pane-expand').hidden`), 'the owner can narrow it from Docs');
  // a doc link in a reply opens the doc in Docs: the width does not change
  await page.eval(`AgentDocsTabUI.open({ name: 'whatever', title: 'Whatever' })`);
  await settle(800);
  assertEquals(await width(), wide, 'opening a doc does not snap the width back');
  // dragging the edge takes over
  await page.eval(`window.dispatchEvent(new CustomEvent('aib-panel-unwiden'))`);
  await page.waitFor(`!document.body.classList.contains('changes-wide')`, 10000, 'the drag ends the widened state');
  assertEquals(await width(), narrow, 'back at the owner\'s width');
  // and the button narrows it
  await page.click('#paneTab-changes');
  await page.click('#paneTabs .pane-expand');
  await page.waitFor(`document.body.classList.contains('changes-wide')`, 10000, 'widened again');
  await page.click('#paneTabs .pane-expand');
  await page.waitFor(`!document.body.classList.contains('changes-wide')`, 10000, 'narrowed by the button');
  a.end();
});
