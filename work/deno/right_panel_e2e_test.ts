/**
 * The right panel is the project's (owner, 2026-11-18; design aib-shared/designs/project-right-panel, slice S1).
 *
 * Activity lists one section per WORKING chat of the project on screen (mid-turn, or its helpers still run), in the order the chats
 * started working; a chat that finishes leaves them. Below them, every other (idle) chat of the project has one collapsed head line,
 * most recently active first (a chat that just stopped on top), the first 10 and a "Show N more" row (owner, 2026-11-18); a caret
 * only when it finished something, expanding (remembered per project and window) lists its finished subagents, each opening its
 * history in the panel. Opening another chat of the project (or
 * moving split focus) moves only the accent (no reorder, show, hide or resize). Each section holds that chat's subagents (finished
 * ones folded into "N finished", remembered per chat) and processes. A subagent history opens inside the panel at its width. The
 * panel's tab is remembered per project and window; a layout with no saved width starts at 320 px; below 320 px of panel the four tabs (Activity, Changes, Artifacts, Docs)
 * are icon + count (also at 125 % display scaling and a bigger interface size). Split view adds Left / Right tags on the pane chats' heads.
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), scripted live chats with scripted
 * subagent_update events, headless Chrome or Edge. The WSL variant of these rules is right_panel_wsl_e2e_test.ts.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/right_panel_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
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
/** A working chat (its turn stays open until `end()`), saying `end` and running the helpers given. */
async function working(lab: Lab, end: string, list: [string, string][] = [], folder = '') {
  const c = await lab.chat(folder);
  await c.start();
  c.say(`Here ${end}`);
  helpers(c, end.toLowerCase(), list);
  return c;
}
/** Wait until the chat has its Activity section (the page reads the chat list every 5 s). */
async function joined(page: Page, c: Chat) {
  await page.waitFor(`!!document.querySelector(${JSON.stringify(`#projectActivity > .sp-grp[data-key=${JSON.stringify(c.key)}]`)})`, 20000, `${c.key} joined`);
}
/** An idle chat: one turn saying `end`, the helpers given, then the turn ends. */
async function idleChat(lab: Lab, end: string, list: [string, string][] = []) {
  const c = await lab.chat();
  await c.start();
  c.say(`Here ${end}`);
  helpers(c, end.toLowerCase(), list);
  c.end();
  return c;
}
/** A: one running, one failed and `done` finished helpers. B: one running and two finished. Both working, A open. */
async function twoChats(lab: Lab, done = 12) {
  const page = lab.page;
  const list: [string, string][] = [['Find rounding bug', 'running'], ['Map tax rules', 'failed']];
  for (let i = 0; i < done; i++) list.push([`Finished job ${i}`, 'completed']);
  const a = await working(lab, 'ALPHAEND', list);
  await lab.select(a); // the panel shows a project once a chat of it is open
  await joined(page, a);
  await settle(1100); // turn start times are whole seconds: a page that first sees both orders them by it
  const b = await working(lab, 'BETAEND', [['Check feed spec', 'running'], ['Read old feed', 'completed'], ['List feeds', 'completed']]);
  await joined(page, b);
  await lab.select(b);
  await shown(page, 'BETAEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  return { a, b };
}

const SEC = (key: string) => `#projectActivity .sp-grp[data-key=${JSON.stringify(key)}]`;
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
const list = (page: Page, key: string) => page.eval<List>(LIST(`${SEC(key)} .sp-subs`));
async function waitFold(page: Page, key: string, want: RegExp, what: string) {
  const box = `${SEC(key)} .sp-subs`;
  await page.waitFor(`(() => { const l = ${LIST(box)}; return !!l && ${want}.test(l.fold); })()`, 20000, what).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await page.eval(LIST(box)))}`);
  });
}
/** The sections: keys in DOM order, boxes (px), which one has the accent, the panel's width. */
const SECTIONS = `(() => {
  const g = [...document.querySelectorAll('#projectActivity > .sp-grp')];
  return { keys: g.map((n) => n.dataset.key), boxes: g.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); }),
    focus: g.filter((n) => n.classList.contains('sp-focus')).map((n) => n.dataset.key),
    panelW: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
    badge: document.querySelector('#paneTab-activity .pane-badge')?.hidden === false ? document.querySelector('#paneTab-activity .pane-badge').textContent : '' };
})()`;
type Sections = { keys: string[]; boxes: string[]; focus: string[]; panelW: number; badge: string };
const sections = (page: Page) => page.eval<Sections>(SECTIONS);
async function waitKeys(page: Page, want: string[], what: string) {
  await page.waitFor(`JSON.stringify((${SECTIONS}).keys) === ${JSON.stringify(JSON.stringify(want))}`, 20000, what).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await sections(page))}`);
  });
}

/** The idle group: keys in DOM order, each head's caret / count / agent text, expanded or not, its box (px), the accent, the
 *  visible subagent titles of expanded ones, and the "Show N more" row. */
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
    boxes: g.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); }),
    focus: g.filter((n) => n.classList.contains('sp-focus')).map((n) => n.dataset.key),
    more: vis(more) ? more.textContent : '' };
})()`;
type Idles = { keys: string[]; heads: string[]; open: string[]; titles: string[][]; boxes: string[]; focus: string[]; more: string };
const idles = (page: Page) => page.eval<Idles>(IDLES);
async function waitIdle(page: Page, test: string, what: string) {
  await page.waitFor(`(() => { const i = ${IDLES}; return ${test}; })()`, 20000, what).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await idles(page))}`);
  });
}
const waitIdleKeys = (page: Page, want: string[], what: string) =>
  waitIdle(page, `JSON.stringify(i.keys) === ${JSON.stringify(JSON.stringify(want))}`, what);

panelTest('right panel: 3 working chats and 1 idle give 3 sections in the order they joined; the idle chat is a head line below them; the tab counts 3', async (lab) => {
  const page = lab.page;
  const a = await working(lab, 'ALPHAEND', [['Find rounding bug', 'running']]);
  await lab.select(a);
  await joined(page, a);
  const b = await working(lab, 'BETAEND');
  await joined(page, b);
  const c = await working(lab, 'GAMMAEND', [['Check feed spec', 'running']]);
  await joined(page, c);
  const idle = await lab.chat();
  await idle.start();
  idle.say('Idle here IDLEEND');
  idle.end();
  await lab.select(idle);
  await shown(page, 'IDLEEND');
  await waitKeys(page, [a.key, b.key, c.key], 'three working chats, in join order');
  const s = await sections(page);
  assertEquals(s.badge, '3', 'the Activity tab counts the working chats');
  assertEquals(s.focus, [], 'the open chat is idle: no working section has the accent');
  // the idle chat: one head line below, no caret and no count (it finished nothing), the agent's name; it has the accent
  await waitIdleKeys(page, [idle.key], 'the idle chat below');
  await settle(1500); // read once
  let i = await idles(page);
  assertEquals(i.heads, ['||Claude Code|off'], 'nothing finished: no caret, no count');
  assertEquals([i.open, i.focus, i.more], [[], [idle.key], ''], 'collapsed, the accent, no "Show more"');
  // a chat that finishes leaves the working sections for the top of the idle group; a new working one joins at the end
  b.end();
  await waitKeys(page, [a.key, c.key], 'B finished: its section left');
  await waitIdleKeys(page, [b.key, idle.key], 'B on top of the idle group');
  const d = await working(lab, 'DELTAEND');
  await waitKeys(page, [a.key, c.key, d.key], 'D joined at the end');
  assertEquals((await sections(page)).badge, '3', 'the tab counts working chats only');
  for (const x of [a, c, d]) x.end();
  await page.waitFor(`!!document.querySelector('#projectActivity > .sp-empty')`, 20000, 'nothing working: the note');
  const note = await page.eval<string>(`document.querySelector('#projectActivity > .sp-empty').textContent`);
  assert(/^No chat in .+ is working\. .*Claude Code, Codex, Gemini, Antigravity and Maki\. All on this PC\.$/.test(note), note);
  assertEquals((await sections(page)).badge, '', 'no count when nothing works');
  await waitIdle(page, 'i.keys.length === 5', 'all five idle, below the note');
  i = await idles(page);
  assertEquals(i.keys[4], idle.key, 'the chat idle longest is last');
  assert(i.keys.indexOf(b.key) > i.keys.indexOf(a.key) && i.keys.indexOf(b.key) > i.keys.indexOf(d.key), `the newest stops on top: ${JSON.stringify(i.keys)}`);
  assert(await page.eval<boolean>(`document.querySelector('#projectActivity > .sp-empty').nextElementSibling?.classList.contains('sp-idle-list')`), 'the idle group follows the note');
});

panelTest('right panel: an idle chat with finished helpers is collapsed below ("N finished", a caret); expanding lists them and a click opens the history at the same width; remembered over a reload', async (lab) => {
  const page = lab.page;
  const w = await working(lab, 'WORKEND', [['Find rounding bug', 'running']]);
  await lab.select(w);
  await joined(page, w);
  const none = await idleChat(lab, 'NONEEND');
  await settle(1100); // a later turn end: "done" is the most recent
  const done = await idleChat(lab, 'DONEEND', [['Port the parser', 'completed'], ['Check the docs', 'completed'], ['Try the old build', 'failed']]);
  await waitIdleKeys(page, [done.key, none.key], 'two idle chats, the most recently active first');
  await waitIdle(page, `i.heads[0] === '▸|3 finished|Claude Code|on'`, 'done: caret and "3 finished"');
  let i = await idles(page);
  assertEquals(i.heads[1], '||Claude Code|off', 'none: no caret, no count');
  assertEquals(i.open, [], 'collapsed by default');
  assertEquals((await sections(page)).keys, [w.key], 'the working section first, alone');
  assertEquals((await sections(page)).badge, '1', 'the tab counts working chats only');
  const w0 = (await sections(page)).panelW;
  await page.click(`${IDLE_SEC(done.key)} .sp-ihead`);
  await waitIdle(page, `i.open.length === 1 && i.titles[0].length === 3`, 'expanded: the three finished helpers');
  i = await idles(page);
  assertEquals(i.heads[0], '▾|3 finished|Claude Code|on');
  assertEquals([...i.titles[0]].sort(), ['Check the docs', 'Port the parser', 'Try the old build']);
  await page.click(`${IDLE_SEC(done.key)} .subagent-card`);
  await page.waitFor(`!document.getElementById('subchatPane').hidden && /Port the parser|Check the docs|Try the old build/.test(document.getElementById('subchatTitle').textContent)`, 10000, "the idle chat's helper history");
  await settle(500);
  assert(await page.eval<boolean>(`document.getElementById('messages').textContent.includes('WORKEND')`), 'the open chat did not change');
  assertEquals(await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`), w0, 'the same width');
  // remembered over a reload (per project and window)
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(w);
  await shown(page, 'WORKEND');
  await waitIdle(page, `i.open.length === 1 && i.open[0] === ${JSON.stringify(done.key)} && i.titles[0].length === 3`, 'still expanded after a reload');
  const saved = await page.eval<Record<string, string[]>>(`JSON.parse(localStorage.getItem('studio-activity-idle-open-v1') || '{}')`);
  assertEquals(Object.values(saved), [[done.key]], 'one project, one expanded chat');
  // collapse again
  await page.click(`${IDLE_SEC(done.key)} .sp-ihead`);
  await waitIdle(page, `i.open.length === 0 && i.heads[0] === '▸|3 finished|Claude Code|on'`, 'collapsed again');
  w.end();
});

panelTest('right panel: opening an idle chat moves only the accent: it does not expand, nothing moves or resizes', async (lab) => {
  const page = lab.page;
  const w = await working(lab, 'WORKEND', [['Find rounding bug', 'running']]);
  await lab.select(w);
  await joined(page, w);
  const one = await idleChat(lab, 'ONEEND', [['First helper', 'completed']]);
  await settle(1100);
  const two = await idleChat(lab, 'TWOEND', [['Second helper', 'completed'], ['Third helper', 'completed']]);
  await waitIdle(page, `JSON.stringify(i.heads) === '["▸|2 finished|Claude Code|on","▸|1 finished|Claude Code|on"]'`, 'both idle with counts');
  await page.click(`${IDLE_SEC(two.key)} .sp-ihead`); // one expanded, one collapsed
  await waitIdle(page, `i.open.length === 1 && i.titles[0].length === 2`, 'two expanded');
  await settle(2500);
  const s0 = await sections(page), i0 = await idles(page);
  assertEquals(i0.focus, [], 'the open chat is working: no idle accent');
  for (const [c, word] of [[one, 'ONEEND'], [two, 'TWOEND'], [w, 'WORKEND']] as [Chat, string][]) {
    await lab.select(c);
    await shown(page, word);
    await settle(2500);
    const s = await sections(page), i = await idles(page);
    assertEquals([s.keys, s.boxes, s.panelW], [s0.keys, s0.boxes, s0.panelW], `${word}: the working sections did not change`);
    assertEquals([i.keys, i.boxes, i.open, i.heads], [i0.keys, i0.boxes, i0.open, i0.heads], `${word}: the idle group did not change`);
    assertEquals([...s.focus, ...i.focus], [c.key], `${word}: only the accent moved`);
  }
  w.end();
});

panelTest('right panel: a working chat that stops goes to the top of the idle group; when it starts again it is back at the end of the working sections', async (lab) => {
  const page = lab.page;
  const a = await working(lab, 'ALPHAEND');
  await lab.select(a);
  await joined(page, a);
  const old = await idleChat(lab, 'OLDEND', [['Old helper', 'completed']]);
  const b = await working(lab, 'BETAEND', [['Beta helper', 'running']]);
  await joined(page, b);
  const c = await working(lab, 'GAMMAEND');
  await waitKeys(page, [a.key, b.key, c.key], 'three working');
  await waitIdleKeys(page, [old.key], 'one idle');
  b.step({ u: { sessionUpdate: 'subagent_update', subagent: { sessionId: 'betaend-helper-0', description: 'Beta helper', state: 'completed' } } });
  b.end();
  await waitKeys(page, [a.key, c.key], 'B left the working sections');
  await waitIdleKeys(page, [b.key, old.key], 'B on top of the idle group');
  await waitIdle(page, `i.heads[0] === '▸|1 finished|Claude Code|on'`, "B's finished helper counted");
  await b.start();
  b.say('Again BETAAGAIN');
  await waitKeys(page, [a.key, c.key, b.key], 'B back, at the end of the working sections');
  await waitIdleKeys(page, [old.key], 'B left the idle group');
  for (const x of [a, b, c]) x.end();
});

panelTest('right panel: all idle chats are visible below the working chats', async (lab) => {
  const page = lab.page;
  const w = await working(lab, 'WORKEND');
  for (let n = 0; n < 12; n++) {
    const s = lab.savedChat(`idle-saved-${n}`);
    s.user(`Question ${n}`);
    s.say(`Answer ${n}`);
  }
  await lab.select(w);
  await joined(page, w);
  await waitIdle(page, `i.keys.length === 12 && i.more === ''`, 'all twelve idle chats');
  assertEquals((await sections(page)).badge, '1', 'the tab counts working chats only');
  assertEquals(await page.eval<string>(`getComputedStyle(document.querySelector('#projectActivity > .sp-focus')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  w.end();
});

panelTest('right panel: opening another chat of the project moves only the accent: no reorder, no size change, same width', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab, 3);
  await waitKeys(page, [a.key, b.key], 'both sections');
  await settle(2500); // both read once
  const before = await sections(page);
  assertEquals(before.focus, [a.key], 'A open: its section has the accent');
  await lab.select(b);
  await shown(page, 'BETAEND');
  await settle(2500);
  const after = await sections(page);
  assertEquals(after.keys, before.keys, 'no reorder');
  assertEquals(after.boxes, before.boxes, 'no section moved or changed size');
  assertEquals(after.panelW, before.panelW, 'the panel kept its width');
  assertEquals(after.focus, [b.key], 'the accent moved to B');
  a.end();
  b.end();
});

panelTest('right panel: finished helpers fold into "N finished" per section, remembered per chat over a chat switch and a reload', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab);
  await waitFold(page, a.key, /^▸ 12 finished$/, 'A: the fold row');
  let l = await list(page, a.key);
  assert(l.open === 'false', `collapsed by default: ${JSON.stringify(l)}`);
  assertEquals(l.titles, ['Find rounding bug', 'Map tax rules'], 'the always-visible rows: working, then failed');
  await waitFold(page, b.key, /^▸ 2 finished$/, 'B: collapsed');
  await page.click(`${SEC(a.key)} .sa-toggle`);
  await waitFold(page, a.key, /^▾ 12 finished$/, 'A: opened');
  l = await list(page, a.key);
  assert(l.open === 'true' && l.titles.length === 14, `A open: ${JSON.stringify(l)}`);
  assertEquals((await list(page, b.key)).titles, ['Check feed spec'], 'B keeps its own state');
  await lab.select(b);
  await shown(page, 'BETAEND');
  await waitFold(page, a.key, /^▾ 12 finished$/, 'A: still open after a chat switch');
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await waitFold(page, a.key, /^▾ 12 finished$/, 'A: still open after a reload');
  a.end();
  b.end();
});

panelTest("right panel: another chat's subagent history opens in the panel at its width; it stays open when you open another chat", async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab, 0);
  await page.waitFor(`!!document.querySelector(${JSON.stringify(SEC(b.key) + ' .subagent-card')})?.offsetParent`, 20000, "B's helper row");
  const w0 = (await sections(page)).panelW;
  assertEquals(w0, 320, 'a layout with no saved width starts at 320 px');
  await page.click(`${SEC(b.key)} .subagent-card`);
  await page.waitFor(`!document.getElementById('subchatPane').hidden && /Check feed spec/.test(document.getElementById('subchatTitle').textContent)`, 10000, "B's helper history");
  await settle(800);
  assert(await page.eval<boolean>(`document.getElementById('messages').textContent.includes('ALPHAEND')`), 'A is still the open chat');
  assertEquals(await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`), w0, 'no widening (the old 480 px)');
  await lab.select(b);
  await shown(page, 'BETAEND');
  await settle(800);
  assert(await page.eval<boolean>(`!document.getElementById('subchatPane').hidden && /Check feed spec/.test(document.getElementById('subchatTitle').textContent)`), 'still open after opening B');
  assertEquals(await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`), w0, 'same width');
  a.end();
  b.end();
});

panelTest('right panel: the tab is remembered per project (and window): another chat of the project keeps it, another project has its own, a reload keeps both', async (lab) => {
  const page = lab.page;
  const a = await working(lab, 'ALPHAEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  const a2 = await working(lab, 'ALPHATWO');
  await joined(page, a2);
  const other = await working(lab, 'OTHEREND', [], 'other');
  await page.waitFor(`StudioChat.state.conversations.some((c) => c.provider + ':' + (c.sessionId || c.id) === ${JSON.stringify(other.key)})`, 20000, 'the other project\'s chat listed');
  await lab.select(a2);
  await shown(page, 'ALPHATWO');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  const tab = () => page.eval<string>(`document.querySelector('#paneTabs [aria-selected="true"]').dataset.tab`);
  const pkOf = (key: string) => page.eval<string>(`AgentWorkspaceUI.projectKeyOf(StudioChat.state.conversations.find((c) => c.provider + ':' + (c.sessionId || c.id) === ${JSON.stringify(key)}))`);
  const pkA = await pkOf(a.key), pkO = await pkOf(other.key);
  assert(pkA && pkO && pkA !== pkO, `two projects: ${pkA} / ${pkO}`);
  await page.click('#paneTab-changes');
  await settle(300);
  await lab.select(a2);
  await shown(page, 'ALPHATWO');
  assertEquals(await tab(), 'changes', 'another chat of the same project keeps Changes');
  await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pkO)})`);
  await lab.select(other);
  await shown(page, 'OTHEREND');
  await page.waitFor(`document.querySelector('#paneTabs [aria-selected="true"]').dataset.tab === 'activity'`, 8000, 'the other project starts on Activity');
  assertEquals(await page.eval<string[]>(`[...document.querySelectorAll('#projectActivity > .sp-grp')].map((g) => g.dataset.key)`), [other.key], "the panel shows the other project's working chat only");
  await page.click('#paneTab-docs');
  await settle(300);
  await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pkA)})`);
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await page.waitFor(`document.querySelector('#paneTabs [aria-selected="true"]').dataset.tab === 'changes'`, 20000, 'back on the first project: Changes');
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await page.waitFor(`document.querySelector('#paneTabs [aria-selected="true"]').dataset.tab === 'changes'`, 15000, 'after a reload: Changes');
  const saved = await page.eval<Record<string, string>>(`JSON.parse(localStorage.getItem('studio-panel-tab-v1') || '{}')`);
  assertEquals(saved[pkA], 'changes');
  assertEquals(saved[pkO], 'docs');
  for (const x of [a, a2, other]) x.end();
});

panelTest('right panel: 320 px only without a saved width; tabs keep their names at the 320 px default and are icon + count below 320 px of panel, at 100 %, 125 % display scaling and a bigger interface size', async (lab) => {
  const page = lab.page;
  const a = await working(lab, 'ALPHAEND', [['Find rounding bug', 'running']]);
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  const look = () => page.eval<{ w: number; own: number; labels: boolean[]; icons: boolean[]; names: string[] }>(`(() => {
    const tabs = [...document.querySelectorAll('#paneTabs .pane-tab')], vis = (n) => !!n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
    return { w: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
      own: Math.round(document.getElementById('paneTabs').offsetWidth),
      labels: tabs.map((t) => vis(t.querySelector('.pane-tab-label'))), icons: tabs.map((t) => vis(t.querySelector('.pane-tab-ico'))),
      names: tabs.map((t) => t.getAttribute('aria-label') + '|' + t.title) };
  })()`);
  let l = await look();
  assertEquals(l.w, 320, 'no saved width: 320 px');
  assert(l.labels.length === 4 && l.labels.every(Boolean) && !l.icons.some(Boolean), `320 px default: four labelled tabs ${JSON.stringify(l)}`);
  assert(l.names.every((n) => /^(Activity|Changes|Artifacts|Docs)/.test(n) && /\|(Activity|Changes|Artifacts|Docs)$/.test(n)), `labels stay in the aria label and tooltip: ${JSON.stringify(l.names)}`);
  // a saved width wins (the layout key of this window-width bucket)
  const save = (w: number) => page.eval(`localStorage.setItem('studio-layout-v1:<1800', JSON.stringify({ activity: ${w} }))`);
  const reload = async () => {
    await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
    await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
    await lab.select(a);
    await shown(page, 'ALPHAEND');
    await settle(600);
  };
  await save(280);
  await reload();
  l = await look();
  assertEquals(l.w, 280, 'a saved 280 stays 280');
  assert(l.icons.every(Boolean) && !l.labels.some(Boolean), `280 px: icon tabs ${JSON.stringify(l)}`);
  await save(360);
  await reload();
  l = await look();
  assertEquals(l.w, 360);
  assert(l.labels.every(Boolean) && !l.icons.some(Boolean), `360 px: labelled tabs ${JSON.stringify(l)}`);
  // 125 % Windows display scaling (device pixels 1.25 per CSS px): CSS widths are the same, so the same switch at 320 CSS px
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1.25, mobile: false });
  await page.eval(`localStorage.removeItem('studio-layout-v1:<1800')`);
  await reload();
  l = await look();
  assertEquals(l.w, 320, '125 % display scaling, no saved width: 320');
  assert(l.labels.every(Boolean) && !l.icons.some(Boolean), `125 % display, 320 px: labelled tabs ${JSON.stringify(l)}`);
  await save(360);
  await reload();
  l = await look();
  assert(l.labels.every(Boolean) && !l.icons.some(Boolean), `125 % display, 360 px: labelled tabs ${JSON.stringify(l)}`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  // AIB's own interface size (steps of 10; 120 % here): widths grow with it and the switch is on the panel's own width (on
  // screen / 1.2): a saved 360 is 300 own (icons), 450 is 375 own (labels); no saved width is 320 x 1.2 = 384 (320 own, labels)
  await page.eval(`AgentTextSize.setUi(120)`);
  await settle(800);
  l = await look();
  assertEquals(l.w, 360, 'a saved width stays as it is at another interface size');
  assert(l.icons.every(Boolean) && !l.labels.some(Boolean), `120 %, 300 own px: icon tabs ${JSON.stringify(l)}`);
  await save(450);
  await reload();
  l = await look();
  assertEquals(l.w, 450);
  assert(l.labels.every(Boolean) && !l.icons.some(Boolean), `120 %, 375 own px: labelled tabs ${JSON.stringify(l)}`);
  await page.eval(`localStorage.removeItem('studio-layout-v1:<1800')`);
  await reload();
  l = await look();
  assertEquals(l.w, 384, '120 %, no saved width: 320 x 1.2');
  assert(l.labels.every(Boolean) && !l.icons.some(Boolean), `120 %, 320 own px: labelled tabs ${JSON.stringify(l)}`);
  await page.eval(`AgentTextSize.setUi(100)`);
  a.end();
});

panelTest('right panel: two pages of the same project list the same sections in the same order', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab, 0);
  await waitKeys(page, [a.key, b.key], 'page 1: both sections');
  const second = await lab.browser.open('about:blank', 1600, 900);
  try {
    await second.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
    await second.waitFor('!!document.getElementById("messages")', 15000, 'page 2');
    await second.waitFor(`document.querySelectorAll('#projectActivity > .sp-grp').length === 2`, 20000, 'page 2: both sections');
    assertEquals((await sections(second)).keys, (await sections(page)).keys, 'same sections, same order');
    assert(second.errors.length === 0, `page 2 console errors: ${second.errors.join(' | ')}`);
  } finally {
    await second.close();
  }
  a.end();
  b.end();
});

/* ---- split view ---- */
async function split(lab: Lab, a: Chat, b: Chat) {
  const page = lab.page;
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2 && !!document.querySelector('.mirror-msgs')`, 15000, 'two panes');
  await page.eval(`(() => { const p = AgentSplitUI.panes().find((p) => p.group.active === ${JSON.stringify(a.key)}); if (p && !p.focused) AgentSplitUI.focusPane(p.id); })()`);
  await page.waitFor(`AgentSplitUI.panes().find((p) => p.focused)?.group.active === ${JSON.stringify(a.key)}`, 15000, 'A focused');
}
const focusedKey = (page: Page) => page.eval<string>(`AgentSplitUI.panes().find((p) => p.focused)?.group.active || ''`);
const tags = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('#projectActivity > .sp-grp')].map((g) => g.querySelector('.sp-pane-tag')?.textContent || '')`);

panelTest('right panel, split view: the same sections with Left / Right tags; a third working chat is listed too; focus moves only the accent', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab, 3);
  await settle(300);
  const c = await working(lab, 'GAMMAEND', [['Third helper', 'running']]);
  await waitKeys(page, [a.key, b.key, c.key], 'three working chats');
  await split(lab, a, b);
  await page.waitFor(`JSON.stringify([...document.querySelectorAll('#projectActivity > .sp-grp')].map((g) => g.querySelector('.sp-pane-tag')?.textContent || '')) === '["Left","Right",""]'`, 15000, 'pane tags').catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await tags(page))}`);
  });
  await waitFold(page, a.key, /^▸ 3 finished$/, "A's section folds");
  await page.click(`${SEC(b.key)} .sa-toggle`);
  await waitFold(page, b.key, /^▾ 2 finished$/, "B's section opened");
  assert((await focusedKey(page)) === a.key, 'opening the fold did not move focus');
  await settle(2000);
  const before = await sections(page);
  await page.click('#splitStage .pane:not(.foc) :is(.mirror-copy > header [data-mid="title"], .mirror-head)');
  await page.waitFor(`AgentSplitUI.panes().find((p) => p.focused)?.group.active === ${JSON.stringify(b.key)}`, 15000, 'focus on B');
  await settle(2500);
  const after = await sections(page);
  assertEquals(after.keys, before.keys, 'no reorder');
  assertEquals(after.boxes, before.boxes, 'no move or size change');
  assertEquals(after.panelW, before.panelW, 'same width');
  assertEquals([before.focus, after.focus], [[a.key], [b.key]], 'only the accent moved');
  assertEquals(await tags(page), ['Left', 'Right', ''], 'tags never follow focus');
  for (const x of [a, b, c]) x.end();
});

panelTest('right panel, split view with a New chat pane: the sections stay, the pane tags go (only one chat on screen)', async (lab) => {
  const page = lab.page;
  const { a, b } = await twoChats(lab, 3);
  await split(lab, a, b);
  await page.waitFor(`document.querySelectorAll('#projectActivity .sp-pane-tag').length === 2`, 15000, 'two tags');
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true }))`);
  await page.waitFor(`AgentSplitUI.panes().some((p) => p.group.active === '__draft__')`, 15000, 'a New chat pane');
  await page.waitFor(`document.querySelectorAll('#projectActivity .sp-pane-tag').length === 0`, 15000, 'no tags with one chat on screen');
  assertEquals((await sections(page)).keys, [a.key, b.key], 'the same working chats');
  assertEquals((await sections(page)).focus, [], 'the New chat view has no section');
  a.end();
  b.end();
});
