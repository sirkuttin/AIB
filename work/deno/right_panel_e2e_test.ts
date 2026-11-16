/**
 * The right panel's Activity tab, finished helpers (owner, 2026-11-16: in beta.11 a chat listed all 54 finished helpers one by
 * one; beta.10 folds them). With one chat: working and failed helpers are listed, every other finished helper sits under one
 * "N finished" row, collapsed by default; opening it is remembered per chat (switching chats, a reload). In split view each
 * chat's section folds the same way, from the same remembered state, and moving pane focus changes nothing.
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), scripted live chats with scripted
 * subagent_update events, headless Chrome or Edge.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/right_panel_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, type Page, settle, shown } from './_scroll_lab.ts';

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
        const owner = await ownerProblems(lab.page);
        assert(!owner, owner);
      } finally {
        await lab.close();
      }
    },
  });
}

function helpers(chat: Chat, tag: string, list: [string, string][]) {
  list.forEach(([desc, state], i) =>
    chat.step({ u: { sessionUpdate: 'subagent_update', subagent: { sessionId: `${tag}-helper-${i}`, description: desc, state } } })
  );
}
/** A: one running, one failed and `done` finished helpers. B: one running and two finished. */
async function twoChats(lab: Lab, done = 12) {
  const page = lab.page;
  const a = await lab.chat();
  await a.start();
  a.say('Alpha here ALPHAEND');
  const list: [string, string][] = [['Find rounding bug', 'running'], ['Map tax rules', 'failed']];
  for (let i = 0; i < done; i++) list.push([`Finished job ${i}`, 'completed']);
  helpers(a, 'a', list);
  const b = await lab.chat();
  await b.start();
  b.say('Beta here BETAEND');
  helpers(b, 'b', [['Check feed spec', 'running'], ['Read old feed', 'completed'], ['List feeds', 'completed']]);
  await lab.select(b);
  await shown(page, 'BETAEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  return { a, b };
}

/** What a box of subagent rows shows: visible card titles, the fold row's text and state. */
const LIST = (box: string) => `(() => {
  const box = document.querySelector(${JSON.stringify(box)});
  if (!box) return null;
  const vis = (n) => !!n && n.getClientRects().length > 0;
  const t = box.querySelector('.sa-toggle');
  return {
    titles: [...box.querySelectorAll('.subagent-card')].filter(vis).map((n) => n.querySelector('.sa-title')?.textContent || ''),
    fold: vis(t) ? t.innerText.replace(/\\s+/g, ' ').trim() : '',
    open: t ? t.getAttribute('aria-expanded') : null,
  };
})()`;
type List = { titles: string[]; fold: string; open: string | null };
const single = (page: Page) => page.eval<List>(LIST('#subagentList'));

async function waitFold(page: Page, box: string, want: RegExp, what: string) {
  await page.waitFor(`(() => { const l = ${LIST(box)}; return !!l && ${want}.test(l.fold); })()`, 20000, what).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await page.eval(LIST(box)))}`);
  });
}

panelTest('right panel, one chat: finished helpers fold into "N finished", collapsed by default', async (lab) => {
  const page = lab.page;
  await twoChats(lab);
  await waitFold(page, '#subagentList', /^▸ 12 finished$/, 'A: the fold row');
  const l = await single(page);
  assert(l.open === 'false', `collapsed by default: ${JSON.stringify(l)}`);
  // the always-visible rows: working, then failed; none of the 12 finished ones
  assert(JSON.stringify(l.titles) === JSON.stringify(['Find rounding bug', 'Map tax rules']), `visible rows: ${JSON.stringify(l.titles)}`);
  assert(!(await page.eval<boolean>(`!!document.querySelector('#splitActivity .sp-grp')?.offsetParent`)), 'no split sections with one chat');
  // the heading is the one-chat heading, not the split label
  const head = await page.eval<string>(`document.querySelector('#subagentList .sa-heading')?.innerText.replace(/\\s+/g, ' ') || ''`);
  assert(/^subagents 1 working · 1 failed/i.test(head), `heading: ${head}`);
});

panelTest('right panel, one chat: opening the fold lists them and is remembered per chat (chat switch, reload)', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab);
  await waitFold(page, '#subagentList', /^▸ 12 finished$/, 'A: the fold row');
  await page.click('#subagentList .sa-toggle');
  await waitFold(page, '#subagentList', /^▾ 12 finished$/, 'A: opened');
  let l = await single(page);
  assert(l.open === 'true' && l.titles.length === 14, `A open: ${JSON.stringify(l)}`);
  assert(l.titles.slice(2).every((t) => /^Finished job \d+$/.test(t)), `finished rows under the fold: ${JSON.stringify(l.titles)}`);
  // B has its own state: still collapsed
  await lab.select(b);
  await shown(page, 'BETAEND');
  await waitFold(page, '#subagentList', /^▸ 2 finished$/, 'B: collapsed');
  assert(JSON.stringify((await single(page)).titles) === JSON.stringify(['Check feed spec']), 'B shows only its working helper');
  // back on A: still open
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await waitFold(page, '#subagentList', /^▾ 12 finished$/, 'A: still open after a chat switch');
  // a reload keeps it
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await waitFold(page, '#subagentList', /^▾ 12 finished$/, 'A: still open after a reload');
  // closing it again
  await page.click('#subagentList .sa-toggle');
  await waitFold(page, '#subagentList', /^▸ 12 finished$/, 'A: closed again');
  l = await single(page);
  assert(l.titles.length === 2, `closed: ${JSON.stringify(l)}`);
});

/* ---- split view ---- */
async function split(lab: Lab, a: Chat, b: Chat) {
  const page = lab.page;
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2 && !!document.querySelector('.mirror-msgs')`, 15000, 'two panes');
  await page.eval(`(() => { const p = AgentSplitUI.panes().find((p) => p.group.active === ${JSON.stringify(a.key)}); if (p && !p.focused) AgentSplitUI.focusPane(p.id); })()`);
  await page.waitFor(`AgentSplitUI.panes().find((p) => p.focused)?.group.active === ${JSON.stringify(a.key)}`, 15000, 'A focused');
}
const SEC = (n: number) => `#splitActivity .sp-grp:nth-child(${n}) .sp-subs`;
const focusedKey = (page: Page) => page.eval<string>(`AgentSplitUI.panes().find((p) => p.focused)?.group.active || ''`);

panelTest('right panel, split view: each chat folds its finished helpers the same way; focus changes nothing', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab);
  await split(lab, a, b);
  await waitFold(page, SEC(1), /^▸ 12 finished$/, "A's section folds");
  await waitFold(page, SEC(2), /^▸ 2 finished$/, "B's section folds");
  const la = await page.eval<List>(LIST(SEC(1)));
  assert(JSON.stringify(la.titles) === JSON.stringify(['Find rounding bug', 'Map tax rules']), `A rows: ${JSON.stringify(la.titles)}`);
  // open B's fold (the unfocused chat): only B's section opens, focus stays on A
  await page.click(`${SEC(2)} .sa-toggle`);
  await waitFold(page, SEC(2), /^▾ 2 finished$/, "B's section opened");
  assert((await page.eval<List>(LIST(SEC(1)))).open === 'false', "A's section stays collapsed");
  assert((await focusedKey(page)) === a.key, 'opening the fold did not move focus');
  const before = JSON.stringify([await page.eval(LIST(SEC(1))), await page.eval(LIST(SEC(2)))]);
  // focus B: neither section changes
  await page.click('#splitStage .pane:not(.foc) :is(.mirror-copy > header [data-mid="title"], .mirror-head)');
  await page.waitFor(`AgentSplitUI.panes().find((p) => p.focused)?.group.active === ${JSON.stringify(b.key)}`, 15000, 'focus on B');
  await settle(2500);
  const after = JSON.stringify([await page.eval(LIST(SEC(1))), await page.eval(LIST(SEC(2)))]);
  assert(before === after, `focus changed the sections:\n${before}\n${after}`);
});

/* ---- split mode only with two chats on screen (owner, 2026-11-16: one chat on screen, yet the panel drew split sections) ----
   A pane showing the New chat view is no chat: the panel is the one-chat panel (Subagents heading, fold, the × in its row),
   about the open chat; with two chats on screen again it lists both. A New chat pane you leave closes (the split collapses). */
const PANEL_MODE = `(() => {
  const vis = (n) => !!n && n.getClientRects().length > 0 && n.getBoundingClientRect().width > 0;
  return {
    splitOn: document.body.classList.contains('split-on'),
    splitPanel: document.body.classList.contains('split-panel'),
    panes: AgentSplitUI.panes().length,
    sections: [...document.querySelectorAll('#splitActivity .sp-grp')].filter(vis).length,
    single: vis(document.getElementById('subagentList')) && vis(document.querySelector('#subagentList .sa-heading')),
    hideInHeading: !!document.querySelector('#subagentList .sa-heading #activityHide'),
  };
})()`;
type Mode = { splitOn: boolean; splitPanel: boolean; panes: number; sections: number; single: boolean; hideInHeading: boolean };
const mode = (page: Page) => page.eval<Mode>(PANEL_MODE);
async function waitMode(page: Page, want: string, what: string) {
  await page.waitFor(`(() => { const m = ${PANEL_MODE}; return ${want}; })()`, 15000, what).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await mode(page))}`);
  });
}

panelTest('right panel: a split with a New chat pane (one chat on screen) shows the one-chat panel; two chats again list both', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab, 3);
  await split(lab, a, b);
  await waitMode(page, 'm.splitPanel && m.sections === 2 && !m.single', 'two chats: split sections');
  // New chat in the focused pane: A's pane shows the New chat view, B's pane B
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true }))`);
  await page.waitFor(`AgentSplitUI.panes().some((p) => p.group.active === '__draft__')`, 15000, 'a New chat pane');
  await waitMode(page, 'm.splitOn && m.panes === 2 && !m.splitPanel && m.sections === 0 && m.single && m.hideInHeading', 'one chat on screen: the one-chat panel');
  await page.click('#paneTab-changes');
  await settle(500);
  assert(!(await page.eval<boolean>(`!!document.querySelector('#splitChanges .sp-grp')?.offsetParent`)), 'Changes: no split sections');
  await page.click('#paneTab-activity');
  // focus B's pane: the New chat view goes, both panes show a chat again
  await page.eval(`(() => { const p = AgentSplitUI.panes().find((p) => p.group.active === ${JSON.stringify(b.key)}); AgentSplitUI.focusPane(p.id); })()`);
  await waitMode(page, 'm.splitPanel && m.sections === 2 && !m.single', 'two chats again: split sections');
});

panelTest('right panel: Ctrl+Backslash on a one-chat window gives a New chat pane (one-chat panel); leaving it closes the pane', async (lab) => {
  const page = lab.page;
  const a = await lab.chat();
  await a.start();
  a.say('Alpha here ALPHAEND');
  helpers(a, 'a', [['Find rounding bug', 'running'], ['Done one', 'completed'], ['Done two', 'completed']]);
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await page.eval(`AgentSplitUI.splitFocused('row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2`, 15000, 'two panes');
  await waitMode(page, 'm.splitOn && !m.splitPanel && m.sections === 0 && m.single', 'New chat pane + one chat: the one-chat panel');
  await page.eval(`(() => { const p = AgentSplitUI.panes().find((p) => p.group.active === ${JSON.stringify(a.key)}); AgentSplitUI.focusPane(p.id); })()`);
  await waitMode(page, '!m.splitOn && !m.splitPanel && m.panes === 0 && m.single', 'the New chat pane closed: one chat, no split');
  await waitFold(page, '#subagentList', /^▸ 2 finished$/, 'the one-chat fold');
});
