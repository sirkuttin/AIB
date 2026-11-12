/**
 * Layout audit, end to end: every scroll container and resizable pane against the events that change sizes (the window, text
 * size, panes opening and closing, the right column widening for a doc or artifact, tabs, the composer, pinned cards, the queue,
 * switching chats, views and themes). A real Studio (Deno web server + in-process agent host, temp state folder, free port; never
 * the live ports), the scripted agent work/scroll-fixture/agent.py, and a headless Chrome/Edge on chat.html (no window), the same
 * harness as scroll_e2e_test.ts (_scroll_lab.ts).
 *
 * Rules every test checks:
 *  - a list that follows the bottom stays at the bottom (and keeps following) through any resize;
 *  - a list you are reading keeps the same row at the same place across width changes (by row, not by pixel offset);
 *  - no list scrolls on its own because a sibling changed;
 *  - no double scrollbars, no sideways scroll; handles respect their minimums; sizes persist.
 *
 * Run (from outputs/agent-studio):
 *   deno test -A ../../work/deno/layout_e2e_test.ts                     passing tests; KNOWN_FAILING ones are listed as ignored
 *   AIB_LAYOUT_ALL=1 deno test -A ../../work/deno/layout_e2e_test.ts    also the known-failing ones (they fail until fixed)
 *   ... --filter "L3"                                                   one test by its number
 * Without Chrome or Edge (CHROME_PATH chooses one) every test is ignored. When a bug is fixed, delete its name from KNOWN_FAILING.
 */
import { assert } from './_assert.ts';
import {
  browserPath,
  type Chat,
  clickHere,
  following,
  Lab,
  m,
  type M,
  type Page,
  rowFramesProblems,
  settle,
  shown,
  sleep,
  startRowFrames,
  stopRowFrames,
  wheel,
} from './_scroll_lab.ts';

const ALL = Deno.env.get('AIB_LAYOUT_ALL') === '1';

/** Tests that fail today: each is a finding in the layout audit (the comment in the test gives the cause and the fix). */
export const KNOWN_FAILING = new Set<string>([
  'L2g following, chat text size and interface size change: the chat stays at the bottom, following',
  'L2m a window resize across a layout bucket (1600 -> 1300 -> 1600) gives the composer and the list back their heights',
  'L4c composer handle: drags between 56 px and a height that leaves the chat list 120 px, the height survives a reload',
  'L6d Settings: each section opens at its top, no double scrollbars, no sideways scroll',
  'L7a split view: the side pane at the bottom stays at the bottom when the window narrows, and keeps following',
  'L2p with the viewer open (chat column ~440 px), the empty message box has no scrollbar of its own',
  // Found when these two started checking every frame (scroll design R6): the old width watcher puts the row back only after the
  // frame that shows it re-wrapped (it reads the anchor on scroll, a redraw replaces the element), so for a frame or more the row is
  // hundreds of px off (L1c: at 439 / 461 instead of -4 in 5 of 73 frames; L2a: at 428 instead of -17). The scroll controller fixes it.
  'L1c reading midway, open a doc from the Artifacts tab: the row you were reading stays at the top of the view',
  'L2a reading midway, the window gets narrower then wider: the row you were reading stays at the top',
]);

function layoutTest(name: string, fn: (lab: Lab) => Promise<void>, size: [number, number] = [1600, 900]) {
  Deno.test({
    name,
    ignore: !browserPath || (KNOWN_FAILING.has(name) && !ALL),
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(size[0], size[1]);
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
      } finally {
        await lab.close();
      }
    },
  });
}

// ---- helpers ------------------------------------------------------------------------------------------------------------------

function seed(chat: Chat, n = 30, tag = 'Seed') {
  for (let i = 0; i < n; i++) {
    chat.say(`${tag} message ${i}. ` + 'Some words to fill a line or two, so that a narrower column wraps them onto more lines. '.repeat(5));
    chat.tool(`${tag}-${i}`, `Read ${tag.toLowerCase()} file ${i}`, 'completed');
  }
}

/** A chat whose turn is running, seeded, drawn at the bottom. */
async function openSeeded(lab: Lab, n = 30): Promise<Chat> {
  const chat = await lab.chat();
  await chat.start();
  seed(chat, n);
  chat.say('Seed done SEEDEND');
  await lab.select(chat);
  await shown(lab.page, 'SEEDEND');
  await settle();
  return chat;
}

/** Scroll the chat up by real wheel input until the reading row is well inside the history (paused, far from both ends). */
async function readMidway(page: Page, box = 'messages', notches = 12) {
  for (let i = 0; i < notches; i++) await wheel(page, -150, box);
  await settle(900);
  const x = await m(page, box);
  assert(x.paused && x.gap > 600, `reading midway: paused ${x.paused}, gap ${x.gap}`);
}

/** The row at the top of the list's view: its text, its offset from the list's top and its height. */
function topRow(page: Page, box = 'messages'): Promise<Row | null> {
  return page.eval(`(() => {
    const b = document.getElementById(${JSON.stringify(box)}), top = b.getBoundingClientRect().top;
    for (const e of b.children) {
      const r = e.getBoundingClientRect();
      if (!r.height || r.bottom <= top + 1) continue;
      for (const x of document.querySelectorAll('[data-audit-anchor]')) x.removeAttribute('data-audit-anchor');
      e.dataset.auditAnchor = '1';
      return { text: e.textContent.replace(/\\s+/g, ' ').slice(0, 80), off: Math.round(r.top - top), h: Math.round(r.height) };
    }
    return null;
  })()`);
}
interface Row {
  text: string;
  off: number;
  h: number;
}

/** The row at the top of the view and the list's numbers: what a resize must not move. */
async function readingState(page: Page, box = 'messages') {
  const a = await topRow(page, box);
  const x = await m(page, box);
  return { a, x };
}

/** After a size change: the same row is still at the top of the view, at the same point of that row (a row that wraps taller
 *  or shorter keeps the line you were on: its offset scales with its height), within `tol` px. null: fine; else what moved. */
async function rowMoved(page: Page, before: Row | null, box = 'messages', tol = 24): Promise<string | null> {
  if (!before) return 'no anchor row before';
  const now = await page.eval<{ off: number; h: number } | null>(`(() => {
    const b = document.getElementById(${JSON.stringify(box)}), top = b.getBoundingClientRect().top;
    const e = b.querySelector(':scope > [data-audit-anchor]') || [...b.children].find((x) => x.textContent.replace(/\\s+/g, ' ').slice(0, 80) === ${JSON.stringify(before.text)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { off: Math.round(r.top - top), h: Math.round(r.height) };
  })()`);
  if (now == null) return `the row "${before.text.slice(0, 40)}" is gone`;
  const want = before.off < 0 && before.h ? Math.round((before.off * now.h) / before.h) : before.off;
  if (Math.abs(now.off - want) > tol) {
    const t = await topRow(page, box);
    return `the row you were reading moved ${now.off - want} px (should be at ${want}, is at ${now.off}; row height ${before.h} -> ${now.h}); the top row is now "${t?.text.slice(0, 50)}" at ${t?.off} h ${t?.h}`;
  }
  return null;
}

const css = (page: Page, name: string) => page.eval<number>(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)})) || 0`);

/** The agent makes a doc (the doc_create row runs, the doc is made and linked to the chat, the row finishes with its card). */
async function agentMakesDoc(lab: Lab, chat: Chat, title: string): Promise<string> {
  chat.tool('mk-doc', 'mcp__studio_artifact__doc_create', 'in_progress', { rawInput: { doc: title } });
  await lab.page.waitFor(`!!document.querySelector('#messages .doc-tool')`, 15000, 'the running doc row');
  const [status, made] = await lab.web.post('docs/open', { id: chat.id, name: title, create: '' });
  assert(status === 200, `docs/open: ${status} ${JSON.stringify(made)}`);
  const name = String(made.name);
  chat.toolDone('mk-doc', JSON.stringify({ ok: true, doc: name, docTitle: title, created: true, pages: [{ id: 'p1', title: 'Page 1' }] }));
  await lab.page.waitFor(`!!document.querySelector('#messages .doc-card')`, 15000, 'the doc card');
  return name;
}

/** The agent publishes an HTML artifact and links it in a reply ([Title](studio-artifact://id)). */
async function agentPublishes(lab: Lab, chat: Chat, title: string, marker: string): Promise<string> {
  const [status, made] = await lab.web.post('artifacts/publish', {
    conversationId: chat.id,
    title,
    content: '<h1>' + title + '</h1>' + '<p>Body text.</p>'.repeat(80),
  });
  assert(status === 200, `artifacts/publish: ${status} ${JSON.stringify(made)}`);
  const id = String(made.id);
  chat.say(`\n\nHere is the page: [${title}](studio-artifact://${id}) ${marker}`);
  await shown(lab.page, marker);
  await lab.page.waitFor(`!!document.querySelector('#messages a.artifact-link[data-artifact-id="${id}"]')`, 15000, 'the artifact link');
  await settle(600);
  return id;
}

const viewing = (page: Page) => page.eval<boolean>(`document.body.classList.contains('ar-viewing')`);

async function waitViewing(page: Page, on: boolean) {
  await page.waitFor(`document.body.classList.contains('ar-viewing') === ${on}`, 10000, on ? 'the right column widens for the viewer' : 'the viewer closes');
  await settle(1200);
}

// ---- L1. the owner's bug: opening a doc or artifact widens the right column, the chat must keep its place -------------------------
//
// Was (beta.8 before this fix): opening a doc or artifact sets body.ar-viewing and resize-ui.js widens the right column from 280
// to 920 px. The chat column loses 640 px, every message wraps onto more lines and the history grows ~2x taller, but nothing put
// the scroll position back: #messages has overflow-anchor: none (AIB keeps the position itself) and its ResizeObserver only
// handled the list getting shorter. A following chat was left far from the bottom; a chat you were reading showed other rows.
// Worse, the click on "Open" / the link was inside #messages, and its "you opened something near the bottom" check saw the gap
// grow and paused following as if you had scrolled up.

layoutTest('L1a following, click "Open doc" on a doc card: the right column widens and the chat stays at the bottom, following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await agentMakesDoc(lab, chat, 'Release plan');
  await settle();
  const before = await m(page);
  assert(!following(before), `following before: ${following(before)}`);
  const w0 = await css(page, '--activity-w');
  await clickHere(page, '#messages .doc-card .art-btn');
  await waitViewing(page, true);
  const w1 = await css(page, '--activity-w');
  assert(w1 > w0 + 200, `the right column widened: ${w0} -> ${w1}`);
  const after = await m(page);
  assert(!following(after), `after opening the doc: ${following(after)} (scrollTop ${before.top} -> ${after.top}, scrollHeight ${before.height} -> ${after.height})`);
  // and it keeps following: the next update stays in view
  chat.say('\n\nA reply after opening AFTEROPEN');
  await shown(page, 'AFTEROPEN');
  await settle();
  const later = await m(page);
  assert(!following(later), `next update: ${following(later)}`);
  chat.end();
});

layoutTest('L1b following, click an artifact link in a reply: the right column widens and the chat stays at the bottom, following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  const id = await agentPublishes(lab, chat, 'Scroll audit page', 'ARTLINK');
  const before = await m(page);
  assert(!following(before), `following before: ${following(before)}`);
  await clickHere(page, `#messages a.artifact-link[data-artifact-id="${id}"]`);
  await waitViewing(page, true);
  const after = await m(page);
  assert(!following(after), `after opening the artifact: ${following(after)} (scrollTop ${before.top} -> ${after.top}, scrollHeight ${before.height} -> ${after.height})`);
  chat.end();
});

layoutTest('L1c reading midway, open a doc from the Artifacts tab: the row you were reading stays at the top of the view', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 40);
  await agentMakesDoc(lab, chat, 'Reading notes');
  await settle();
  await clickHere(page, '#paneTab-artifacts');
  await page.waitFor(`!!document.querySelector('.ar-empty .ar-doc')`, 8000, 'the doc row in the Artifacts tab');
  await readMidway(page);
  const { a, x } = await readingState(page);
  await startRowFrames(page, a!.text);
  await clickHere(page, '.ar-empty .ar-doc');
  await waitViewing(page, true);
  const drawn = rowFramesProblems(await stopRowFrames(page), a!, 24);
  const moved = await rowMoved(page, a);
  const y = await m(page);
  assert(!moved, `${moved} (scrollTop ${x.top} -> ${y.top}, scrollHeight ${x.height} -> ${y.height})`);
  assert(!drawn, `while the column widened, frame by frame: ${drawn}`);
  assert(y.paused, 'still paused (you were reading)');
  chat.end();
});

layoutTest('L1d reading midway, close the viewer (the column narrows back): the row you were reading stays put', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 40);
  const id = await agentPublishes(lab, chat, 'Close me', 'CLOSEME');
  await clickHere(page, `#messages a.artifact-link[data-artifact-id="${id}"]`);
  await waitViewing(page, true);
  await readMidway(page);
  const { a, x } = await readingState(page);
  // leave the viewer: switch the right column back to the Activity tab (the viewer is hidden, the column narrows)
  await clickHere(page, '#paneTab-activity');
  await waitViewing(page, false);
  const moved = await rowMoved(page, a);
  const y = await m(page);
  assert(!moved, `${moved} (scrollTop ${x.top} -> ${y.top}, scrollHeight ${x.height} -> ${y.height})`);
  chat.end();
});

// ---- shared measuring ---------------------------------------------------------------------------------------------------------

/** Every visible scroll container on the page: whether it overflows each way, and the nested pairs where a list that overflows
 *  sits inside another that overflows (two scrollbars for one gesture). Elements under visibility: hidden, with no box, or
 *  outside the window are skipped. The page itself must never scroll. */
const SWEEP = `(() => {
  const name = (e) => e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const scrollers = [];
  for (const e of document.querySelectorAll('*')) {
    const cs = getComputedStyle(e);
    const sy = cs.overflowY === 'auto' || cs.overflowY === 'scroll', sx = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if ((!sy && !sx) || cs.visibility === 'hidden' || !e.getClientRects().length) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight) continue;
    scrollers.push({ e, n: name(e), vo: sy && e.scrollHeight > e.clientHeight + 1, ho: sx && e.scrollWidth > e.clientWidth + 1 });
  }
  const nested = [];
  for (const s of scrollers) {
    if (!s.vo) continue;
    for (let p = s.e.parentElement; p; p = p.parentElement) {
      const o = scrollers.find((x) => x.e === p);
      if (o && o.vo) { nested.push(o.n + ' > ' + s.n); break; }
    }
  }
  const d = document.documentElement;
  return {
    page: { sh: d.scrollHeight, ih: innerHeight, sw: d.scrollWidth, iw: innerWidth, top: Math.round(d.scrollTop + document.body.scrollTop) },
    nested,
    sideways: scrollers.filter((s) => s.ho).map((s) => s.n + ' ' + s.e.scrollWidth + '/' + s.e.clientWidth),
  };
})()`;
interface Sweep {
  page: { sh: number; ih: number; sw: number; iw: number; top: number };
  nested: string[];
  sideways: string[];
}
const sweep = (page: Page) => page.eval<Sweep>(SWEEP);

/** Page-level problems: the page scrolls, double scrollbars, sideways scroll (`allow`: selector starts of boxes that scroll
 *  sideways on purpose, code blocks and tables). */
function sweepProblems(s: Sweep, allow: string[] = []): string[] {
  const bad: string[] = [];
  if (s.page.sh > s.page.ih + 1 || s.page.sw > s.page.iw + 1 || s.page.top) bad.push(`the page itself scrolls: ${JSON.stringify(s.page)}`);
  if (s.nested.length) bad.push(`double scrollbars: ${s.nested.join('; ')}`);
  const side = s.sideways.filter((x) => !allow.some((a) => x.startsWith(a)));
  if (side.length) bad.push(`sideways scroll: ${side.join('; ')}`);
  return bad;
}

/** Drag a handle (by id) by dx/dy with real mouse input, in 6 steps. */
async function dragHandle(page: Page, id: string, dx: number, dy = 0) {
  const [x, y] = await page.eval<[number, number]>(
    `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 6; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 6, y: y + (dy * i) / 6, button: 'left', buttons: 1 });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(300);
}

const heightOf = (page: Page, sel: string) => page.eval<number>(`Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().height)`);

async function reload(lab: Lab, chat: { key: string }) {
  await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await lab.page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(chat);
  await settle(1200);
}

/** Reading midway, run `act`, then the row must still be at the top and the list still paused. */
async function keepsReadingRow(page: Page, act: () => Promise<unknown>, what: string, box = 'messages', scrollFirst = true) {
  if (scrollFirst) await readMidway(page, box);
  const { a, x } = await readingState(page, box);
  await act();
  await settle(1200);
  const moved = await rowMoved(page, a, box);
  const y = await m(page, box);
  assert(!moved, `${what}: ${moved} (scrollTop ${x.top} -> ${y.top}, scrollHeight ${x.height} -> ${y.height}, clientHeight ${x.client} -> ${y.client})`);
  assert(y.paused, `${what}: still paused`);
}

/** Not following, and why: off the bottom, paused, or the newest row drawn below the list. Rows are compared with the list's
 *  drawn box (getBoundingClientRect): with the chat text size above 100 % the list is zoomed and clientHeight is not. */
async function followIssues(page: Page, box = 'messages'): Promise<{ bad: string; x: M }> {
  const x = await m(page, box);
  const drawn = await page.eval<number>(`(() => { const b = document.getElementById(${JSON.stringify(box)}), r = b.getBoundingClientRect();
    const kids = [...b.children].filter((e) => e.offsetParent !== null && !e.classList.contains('new-line')), l = kids[kids.length - 1];
    return l ? Math.round(l.getBoundingClientRect().bottom - r.bottom) : 0; })()`);
  const bad = [x.gap > 1 ? `${x.gap} px from the bottom` : '', x.paused ? 'paused (follow switched off)' : '', drawn > 1 ? `newest row ends ${drawn} px below the list` : '']
    .filter(Boolean).join(', ');
  return { bad, x };
}

/** Following, run `act`, then the list must still be at the bottom and following. */
async function keepsFollowing(page: Page, act: () => Promise<unknown>, what: string, box = 'messages') {
  const before = await followIssues(page, box);
  assert(!before.bad, `${what}: following before: ${before.bad}`);
  const x = before.x;
  await act();
  await settle(1200);
  const { bad, x: y } = await followIssues(page, box);
  assert(!bad, `${what}: ${bad} (scrollTop ${x.top} -> ${y.top}, scrollHeight ${x.height} -> ${y.height}, clientHeight ${x.client} -> ${y.client})`);
}

async function fileLinkInReply(lab: Lab, chat: Chat) {
  Deno.writeTextFileSync(`${lab.fx.workspace}\\notes.txt`, 'line one\nline two\n');
  chat.say('\n\nI wrote notes.txt FILEREADY');
  await shown(lab.page, 'FILEREADY');
  await lab.page.waitFor(`!!document.querySelector('#messages a.fx-path')`, 15000, 'the file link');
  await settle();
}

// ---- L2. chat history (#messages) against every event that changes its size ------------------------------------------------------

layoutTest('L2a reading midway, the window gets narrower then wider: the row you were reading stays at the top', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 40);
  await readMidway(page);
  const r0 = await readingState(page);
  await startRowFrames(page, r0.a!.text);
  await keepsReadingRow(page, () => page.viewport(1200, 900), 'window 1600 -> 1200', 'messages', false);
  const narrower = rowFramesProblems(await stopRowFrames(page), r0.a!, 24);
  assert(!narrower, `window 1600 -> 1200, frame by frame: ${narrower}`);
  const { a } = await readingState(page);
  await startRowFrames(page, a!.text);
  await page.viewport(1600, 900);
  await settle(1200);
  const wider = rowFramesProblems(await stopRowFrames(page), a!, 24);
  const moved = await rowMoved(page, a);
  assert(!moved, `window 1200 -> 1600: ${moved}`);
  assert(!wider, `window 1200 -> 1600, frame by frame: ${wider}`);
});

layoutTest('L2b following, the window gets narrower and shorter, then back: the chat stays at the bottom, following', async (lab) => {
  const page = lab.page;
  await openSeeded(lab);
  await keepsFollowing(page, () => page.viewport(1200, 700), 'window 1600x900 -> 1200x700');
  await keepsFollowing(page, () => page.viewport(1600, 900), 'window back to 1600x900');
});

layoutTest('L2c reading midway, a file opens beside the chat (the chat column narrows): the row you were reading stays', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 40);
  await fileLinkInReply(lab, chat);
  // open it without scrolling the list to the link (as the Files tree or Ctrl+K would)
  await keepsReadingRow(page, async () => {
    await page.eval(`document.querySelector('#messages a.fx-path').click()`);
    await page.waitFor(`document.body.classList.contains('sf-beside-on')`, 10000, 'the file beside the chat');
  }, 'file beside the chat');
  chat.end();
});

layoutTest('L2d following, a file opens beside the chat: the chat stays at the bottom, following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await fileLinkInReply(lab, chat);
  await keepsFollowing(page, async () => {
    await clickHere(page, '#messages a.fx-path');
    await page.waitFor(`document.body.classList.contains('sf-beside-on')`, 10000, 'the file beside the chat');
  }, 'file beside the chat');
  chat.end();
});

layoutTest('L2e reading midway, chat text size 100 -> 130 %: the row you were reading stays at the top', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 40);
  await keepsReadingRow(page, () => page.eval('AgentTextSize.setChat(130)'), 'chat text 130 %');
});

layoutTest('L2f reading midway, interface size 100 -> 125 %: the row you were reading stays at the top', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 40);
  await keepsReadingRow(page, () => page.eval('AgentTextSize.setUi(125)'), 'interface 125 %');
});

// Fails today: chat text at 130 %, then the interface size 100 -> 125 %: the list ends 657 px above the bottom with follow switched
// off (scrollTop 3451 -> 3486, scrollHeight 3959 -> 4585, clientHeight 509 -> 442). The interface size zooms the column, the list
// gets shorter and its rows taller in one step; a scroll event (the 48 px rule, chat.js scroll handler ~4806) pauses it before the
// ResizeObserver can keep it at the bottom. Fix: treat any size change of #messages like the width change (chat.js width watcher):
// mark the time on every ResizeObserver change, and let a text-size change (AgentTextSize.onChange) mark it before it applies.
layoutTest('L2g following, chat text size and interface size change: the chat stays at the bottom, following', async (lab) => {
  const page = lab.page;
  await openSeeded(lab);
  await keepsFollowing(page, () => page.eval('AgentTextSize.setChat(130)'), 'chat text 130 %');
  await keepsFollowing(page, () => page.eval('AgentTextSize.setUi(125)'), 'interface 125 %');
  await keepsFollowing(page, () => page.eval('AgentTextSize.setUi(100)'), 'interface 100 %');
});

layoutTest('L2h reading midway, the chat list and the right column hide and show (Ctrl+B, Ctrl+Alt+B): the row stays', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 40);
  await keepsReadingRow(page, () => page.key('b', 2), 'chat list hidden');
  await keepsReadingRow(page, () => page.key('b', 3), 'right column hidden');
  await keepsReadingRow(page, async () => {
    await page.key('b', 2);
    await page.key('b', 3);
  }, 'both shown again');
});

layoutTest('L2i reading midway, the theme changes (dark -> light -> high contrast): nothing scrolls', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 40);
  await keepsReadingRow(page, async () => {
    await page.eval('AibThemes.choose("teal-light")');
    await settle(500);
    await page.eval('AibThemes.choose("hc-dark")');
  }, 'theme changes');
});

layoutTest('L2j reading midway, switching the right column between Activity, Changes and Artifacts: nothing scrolls', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 40);
  await keepsReadingRow(page, async () => {
    for (const t of ['changes', 'artifacts', 'activity']) {
      await clickHere(page, `#paneTab-${t}`);
      await settle(400);
    }
  }, 'right column tabs');
});

layoutTest('L2k reading midway, an approval card pins under the list: the row you were reading stays', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 40);
  await keepsReadingRow(page, async () => {
    chat.step({ ask: 'Run rm -rf build' });
    await page.waitFor('(document.getElementById("approvals").textContent || "").includes("rm -rf build")', 15000, 'approval card');
  }, 'approval card');
});

layoutTest('L2l reading midway, the composer grows to 6 lines: the row you were reading stays', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 40);
  await keepsReadingRow(page, async () => {
    await page.eval('document.getElementById("prompt").focus()');
    await page.type('one\ntwo\nthree\nfour\nfive\nsix');
  }, 'composer 6 lines');
});

// Fails today: the message box is 56 px tall at load but 64 px after the window crosses a layout bucket (1400 / 1800 px) and back;
// the list loses 8 px for good. resize-ui.js onResize (~572) clears the prompt's inline height and re-fires "input", and the
// autosize (workspace-ui.js ~1332) sizes an empty box to 64 px, while the first paint uses the CSS height (rows=2, 56 px). Fix: run the
// same autosize once at load, or only clear the height when the stored composer size differs between the buckets.
layoutTest('L2m a window resize across a layout bucket (1600 -> 1300 -> 1600) gives the composer and the list back their heights', async (lab) => {
  const page = lab.page;
  await openSeeded(lab);
  const before = { prompt: await heightOf(page, '#prompt'), list: await heightOf(page, '#messages') };
  await page.viewport(1300, 900);
  await settle(800);
  await page.viewport(1600, 900);
  await settle(1000);
  const after = { prompt: await heightOf(page, '#prompt'), list: await heightOf(page, '#messages') };
  assert(after.prompt === before.prompt && after.list === before.list, `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
});

layoutTest('L2n a long unbroken line (URL, path, word) and a wide table in a reply never make the chat scroll sideways, 1600 and 860 px', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 4);
  chat.say('\n\nA long one: https://example.com/' + 'a'.repeat(400) + ' and C:\\' + 'folder\\'.repeat(60) + 'file.txt and ' + 'f'.repeat(300) + ' LONGLINE');
  chat.say('\n\n| a | b | c | d | e | f | g |\n|---|---|---|---|---|---|---|\n' + ('| ' + 'cell text '.repeat(6) + ' ').repeat(7) + '|\n\nTABLEEND');
  await shown(page, 'TABLEEND');
  await settle();
  const problems: string[] = [];
  for (const w of [1600, 860]) {
    await page.viewport(w, 800);
    await settle(1000);
    const bad = sweepProblems(await sweep(page), ['pre', 'code', 'table', 'div.md-table', 'div.table']);
    const msgs = await page.eval<{ sw: number; cw: number }>(`(() => { const b = document.getElementById('messages'); return { sw: b.scrollWidth, cw: b.clientWidth }; })()`);
    if (msgs.sw > msgs.cw + 1 || bad.length) problems.push(`at ${w} px: #messages ${msgs.sw}/${msgs.cw}; ${bad.join('; ')}`);
  }
  assert(!problems.length, problems.join('\n'));
  chat.end();
});

layoutTest('L2o following, Settings opens over the chat and closes: the chat is still at the bottom, following', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await keepsFollowing(page, async () => {
    await clickHere(page, '#openSettings');
    await page.waitFor(`document.body.classList.contains('settings-open')`, 8000, 'settings open');
    await settle(500);
    await page.key('Escape');
    await page.waitFor(`!document.body.classList.contains('settings-open')`, 8000, 'settings closed');
  }, 'settings open and closed');
  chat.say('\n\nAfter settings AFTERSET');
  await shown(page, 'AFTERSET');
  await settle();
  const y = await m(page);
  assert(!following(y), `next update after settings: ${following(y)}`);
});

// ---- L3. the subagent view (#submessages) ----------------------------------------------------------------------------------------

const agentCall = (i: number | string) => ({
  u: { sessionUpdate: 'tool_call', toolCallId: `agent-${i}`, title: 'Agent', kind: 'think', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } },
});
const childStarts = (i: number | string, title: string) => ({
  u: { sessionUpdate: 'subagent_update', sessionId: `child-${i}`, title, capabilities: { cancel: {} }, state: { state: 'running' } },
});

async function openSubagent(lab: Lab) {
  const page = lab.page;
  const chat = await lab.chat();
  await chat.start();
  chat.say('Starting a helper');
  chat.step(agentCall(1), childStarts(1, 'Review the code'));
  const child = (u: Record<string, unknown>) => chat.step({ sid: 'child-1', u: { ...u, _meta: { claudeCode: { parentToolUseId: 'agent-1' } } } });
  for (let i = 0; i < 40; i++) {
    child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Child message ${i}. ` + 'Helper words that wrap onto more lines when the column is narrow. '.repeat(5) + '\n\n' } });
    child({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: `Child read ${i}`, kind: 'read', status: 'completed' });
  }
  await lab.select(chat);
  await page.waitFor(`!!document.querySelector('#subagentList button[data-key="child-1"]')`, 15000, 'subagent card');
  await clickHere(page, '#subagentList button[data-key="child-1"]');
  await shown(page, 'Child read 39', 'submessages');
  await settle();
  return { chat, child };
}

layoutTest('L3a subagent view following: the right column is dragged wider and the window narrower, it stays at the bottom', async (lab) => {
  const page = lab.page;
  await openSubagent(lab);
  await keepsFollowing(page, () => dragHandle(page, 'rs-activity', -200), 'right column 200 px wider', 'submessages');
  await keepsFollowing(page, () => page.viewport(1250, 900), 'window 1250 px', 'submessages');
});

layoutTest('L3b subagent view reading: the right column is dragged wider, the row you were reading stays at the top', async (lab) => {
  const page = lab.page;
  await openSubagent(lab);
  await keepsReadingRow(page, () => dragHandle(page, 'rs-activity', -250), 'right column 250 px wider', 'submessages');
});

layoutTest('L3c the main chat, reading: opening a subagent (the right column widens to 480 px) keeps the row you read', async (lab) => {
  const page = lab.page;
  const chat = await lab.chat();
  await chat.start();
  seed(chat, 40);
  chat.step(agentCall(1), childStarts(1, 'Review the code'));
  chat.step({ sid: 'child-1', u: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child words' }, _meta: { claudeCode: { parentToolUseId: 'agent-1' } } } });
  chat.say('Seed done SEEDEND');
  await lab.select(chat);
  await shown(page, 'SEEDEND');
  await page.waitFor(`!!document.querySelector('#subagentList button[data-key="child-1"]')`, 15000, 'subagent card');
  await settle();
  await keepsReadingRow(page, () => clickHere(page, '#subagentList button[data-key="child-1"]'), 'subagent opened');
});

// ---- L4. resizable panes: handles, minimums, persistence -----------------------------------------------------------------------

layoutTest('L4a chat list handle: drags within 200..480 px, the width survives a reload, no stray scrollbars', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 4);
  const w0 = await css(page, '--side-w');
  await dragHandle(page, 'rs-side', 120);
  const w1 = await css(page, '--side-w');
  assert(Math.abs(w1 - (w0 + 120)) <= 3, `grew by 120: ${w0} -> ${w1}`);
  await dragHandle(page, 'rs-side', 2000);
  const wMax = await css(page, '--side-w');
  assert(wMax === 480, `max 480: ${wMax}`);
  await dragHandle(page, 'rs-side', -(480 - 205));
  const w2 = await css(page, '--side-w');
  assert(w2 >= 200 && w2 <= 210, `near the minimum: ${w2}`);
  await reload(lab, chat);
  const w3 = await css(page, '--side-w');
  assert(Math.abs(w3 - w2) <= 1, `kept after a reload: ${w2} -> ${w3}`);
  const bad = sweepProblems(await sweep(page));
  assert(!bad.length, bad.join('; '));
});

layoutTest('L4b right column handle: the chat keeps 420 px; the viewer width is kept apart from the normal one and survives a reload', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 4);
  await dragHandle(page, 'rs-activity', -3000);
  const side = await css(page, '--side-w'), act = await css(page, '--activity-w');
  assert(1600 - side - act >= 419, `the chat column keeps 420 px: side ${side}, right ${act}`);
  await dragHandle(page, 'rs-activity', 3000);
  await page.key('b', 3); // a drag far past the minimum collapses it: show it again
  await settle(600);
  const normal = await css(page, '--activity-w');
  assert(normal >= 220, `shown again at a real width: ${normal}`);
  const id = await agentPublishes(lab, chat, 'Width page', 'WIDTHPAGE');
  await clickHere(page, `#messages a.artifact-link[data-artifact-id="${id}"]`);
  await waitViewing(page, true);
  const v0 = await css(page, '--activity-w');
  await dragHandle(page, 'rs-activity', v0 - 700);
  const v1 = await css(page, '--activity-w');
  assert(Math.abs(v1 - 700) <= 3, `viewer dragged to 700: ${v0} -> ${v1}`);
  await clickHere(page, '#paneTab-activity');
  await waitViewing(page, false);
  const back = await css(page, '--activity-w');
  assert(Math.abs(back - normal) <= 1, `the normal width is untouched by the viewer drag: ${normal} -> ${back}`);
  await reload(lab, chat);
  await clickHere(page, `#messages a.artifact-link[data-artifact-id="${id}"]`);
  await waitViewing(page, true);
  const v2 = await css(page, '--activity-w');
  assert(Math.abs(v2 - 700) <= 3, `viewer width kept after a reload: ${v2}`);
  chat.end();
});

// Fails today: dragging the message box up as far as it goes leaves the chat list 36 px tall (box 700 px in a 900 px window).
// resize-ui.js composerMax (~102) is the window height minus 200, but the header, tabs, turn row and chips take ~164 of those 200.
// Fix: cap the box at the room the chat column really has minus 120 px for the list (measure #messages' top and the box's top
// at drag start), not at innerHeight - 200.
layoutTest('L4c composer handle: drags between 56 px and a height that leaves the chat list 120 px, the height survives a reload', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 4);
  await page.waitFor(`!document.getElementById('rs-composer').hidden`, 8000, 'composer handle');
  await dragHandle(page, 'rs-composer', 0, -150);
  const h1 = await heightOf(page, '#prompt');
  assert(h1 >= 150, `taller: ${h1}`);
  await dragHandle(page, 'rs-composer', 0, -2000);
  const h2 = await heightOf(page, '#prompt');
  assert(h2 <= 900 - 200 + 2, `at most the window minus 200: ${h2}`);
  const list = await heightOf(page, '#messages');
  assert(list >= 120, `the chat list keeps at least 120 px (a few rows) next to the tallest message box: ${list} px (box ${h2} px)`);
  await dragHandle(page, 'rs-composer', 0, 3000);
  const h3 = await heightOf(page, '#prompt');
  assert(h3 >= 56 && h3 <= 60, `at least 56: ${h3}`);
  await dragHandle(page, 'rs-composer', 0, -100);
  const h4 = await heightOf(page, '#prompt');
  await reload(lab, chat);
  const h5 = await heightOf(page, '#prompt');
  assert(Math.abs(h5 - h4) <= 2, `kept after a reload: ${h4} -> ${h5}`);
  chat.end();
});

async function manyHelpers(lab: Lab, n: number) {
  const page = lab.page;
  const chat = await lab.chat();
  await chat.start();
  for (let i = 0; i < n; i++) chat.step(agentCall(i), childStarts(i, `Helper ${i}`));
  chat.say('Many helpers HELPERS');
  await lab.select(chat);
  await shown(page, 'HELPERS');
  await page.waitFor(`document.querySelectorAll('#subagentList button[data-key]').length >= ${n}`, 15000, `${n} subagent cards`);
  await settle(800);
  return chat;
}

layoutTest('L4d Subagents / Processes split: each keeps 96 px, the split survives a reload, no double scrollbars', async (lab) => {
  const page = lab.page;
  const chat = await manyHelpers(lab, 14);
  await page.waitFor(`!document.getElementById('rs-split').hidden`, 8000, 'split handle');
  await dragHandle(page, 'rs-split', 0, -2000);
  const top = await heightOf(page, '#subagentList');
  assert(top >= 95 && top <= 98, `Subagents keeps 96: ${top}`);
  await dragHandle(page, 'rs-split', 0, 2000);
  const proc = await heightOf(page, '#commandSection');
  assert(proc >= 95, `Processes keeps 96: ${proc}`);
  await dragHandle(page, 'rs-split', 0, -150);
  const chosen = await heightOf(page, '#subagentList');
  const bad = sweepProblems(await sweep(page));
  assert(!bad.length, bad.join('; '));
  await reload(lab, chat);
  await page.waitFor(`document.querySelectorAll('#subagentList button[data-key]').length >= 14`, 15000, 'cards after reload');
  await settle(800);
  const again = await heightOf(page, '#subagentList');
  assert(Math.abs(again - chosen) <= 3, `kept after a reload: ${chosen} -> ${again}`);
  chat.end();
});

// ---- L5. no page scroll, no double scrollbars, at every size ---------------------------------------------------------------------

layoutTest('L5a the page never scrolls and no list has a second scrollbar, from 1920x1080 down to 700x500, at 100 and 150 %', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 30);
  await agentMakesDoc(lab, chat, 'Sizes');
  const problems: string[] = [];
  for (const [w, h] of [[1920, 1080], [1600, 900], [1280, 720], [1100, 700], [1000, 640], [860, 600], [700, 500]]) {
    await page.viewport(w, h);
    await settle(700);
    for (const ui of [100, 150]) {
      await page.eval(`AgentTextSize.setUi(${ui})`);
      await settle(500);
      const bad = sweepProblems(await sweep(page), ['pre', 'code', 'table']);
      if (bad.length) problems.push(`${w}x${h} at ${ui} %: ${bad.join('; ')}`);
    }
    await page.eval('AgentTextSize.setUi(100)');
  }
  assert(!problems.length, problems.join('\n'));
  chat.end();
});

layoutTest('L5b the doc viewer dragged to its narrowest and widest: no sideways scroll in the doc, no double scrollbars', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 4);
  await agentMakesDoc(lab, chat, 'Narrow doc');
  await clickHere(page, '#messages .doc-card .art-btn');
  await waitViewing(page, true);
  await page.waitFor(
    `(() => { const d = document.querySelector('iframe.ar-docframe')?.contentDocument; return d && d.querySelector('#docApp .ProseMirror'); })() && true`,
    20000,
    'the doc editor',
  );
  const problems: string[] = [];
  for (const dx of [640, -2000]) {
    await dragHandle(page, 'rs-activity', dx);
    await settle(900);
    const r = await page.eval<Record<string, number>>(`(() => {
      const f = document.querySelector('iframe.ar-docframe'), d = f.contentDocument, e = d.scrollingElement;
      return { col: Math.round(f.getBoundingClientRect().width), sw: e.scrollWidth, cw: e.clientWidth };
    })()`);
    if (r.sw > r.cw + 1) problems.push(`column ${r.col} px: the doc scrolls sideways (${r.sw}/${r.cw})`);
    const s = sweepProblems(await sweep(page));
    if (s.length) problems.push(`column ${r.col} px: ${s.join('; ')}`);
  }
  assert(!problems.length, problems.join('\n'));
  chat.end();
});

// ---- L6. lists that must not scroll because a sibling changed, popovers that must fit -------------------------------------------

layoutTest('L6a sidebar chat list: scrolled down, opening a chat in it does not scroll the list', async (lab) => {
  const page = lab.page;
  for (let i = 0; i < 40; i++) {
    const s = lab.savedChat(`5eed${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`);
    s.user(`Question ${i}`);
    s.say(`Answer ${i}`);
  }
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor(`document.querySelectorAll('#connections button.connection').length >= 40`, 20000, '40 chats in the sidebar');
  await settle(800);
  await page.eval(`document.getElementById('connections').scrollTop = 600`);
  await settle(300);
  const before = await page.eval<number>(`document.getElementById('connections').scrollTop`);
  const target = await page.eval<string>(`(() => { const c = document.getElementById('connections'), t = c.getBoundingClientRect();
    const b = [...c.querySelectorAll('button.connection')].find((x) => { const r = x.getBoundingClientRect(); return r.top > t.top + 40 && r.bottom < t.bottom - 40; });
    return b ? b.dataset.key : ''; })()`);
  assert(target, 'a visible chat row');
  await clickHere(page, `button.connection[data-key="${target}"]`);
  await page.waitFor(`document.querySelector('button.connection[data-key="${target}"]')?.classList.contains('selected')`, 10000, 'chat selected');
  await settle(1500);
  const after = await page.eval<number>(`document.getElementById('connections').scrollTop`);
  assert(Math.abs(after - before) <= 2, `the chat list scrolled by itself: ${before} -> ${after}`);
});

layoutTest('L6b right column: the Subagents list keeps its scroll position across a tab switch (Activity -> Changes -> Activity)', async (lab) => {
  const page = lab.page;
  const chat = await manyHelpers(lab, 30);
  const SA = `document.querySelector('#subagentList > .sa-scroll')`;
  const box = await page.eval<{ sh: number; ch: number }>(`(() => { const b = ${SA}; return { sh: b.scrollHeight, ch: b.clientHeight }; })()`);
  assert(box.sh > box.ch + 50, `the Subagents list scrolls: ${JSON.stringify(box)}`);
  await page.eval(`${SA}.scrollTop = 120`);
  await settle(300);
  const before = await page.eval<number>(`${SA}.scrollTop`);
  await clickHere(page, '#paneTab-changes');
  await settle(600);
  await clickHere(page, '#paneTab-activity');
  await settle(800);
  const after = await page.eval<number>(`${SA}.scrollTop`);
  assert(Math.abs(after - before) <= 2, `Subagents list scroll lost on a tab switch: ${before} -> ${after}`);
  chat.end();
});

layoutTest('L6c inbox popover in a short window: it stays inside the window, also after the window shrinks while it is open', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 4);
  await page.viewport(1400, 520);
  await settle(800);
  await page.waitFor(`!!document.querySelector('.ws-inbox-btn')`, 8000, 'inbox button');
  await clickHere(page, '.ws-inbox-btn');
  await page.waitFor(`!document.getElementById('wsInbox').hidden`, 8000, 'inbox open');
  await settle(500);
  const fit = () => page.eval<Record<string, number>>(`(() => { const p = document.getElementById('wsInbox'), r = p.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), ih: innerHeight, iw: innerWidth }; })()`);
  const a = await fit();
  assert(a.bottom <= a.ih && a.right <= a.iw && a.left >= 0, `inside the window: ${JSON.stringify(a)}`);
  await page.viewport(900, 420);
  await settle(800);
  if (await page.eval<boolean>(`!document.getElementById('wsInbox').hidden`)) {
    const b = await fit();
    assert(b.bottom <= b.ih && b.right <= b.iw && b.left >= 0, `after the window shrank to 900x420: ${JSON.stringify(b)}`);
  }
});

// Fails today: scroll a Settings section to its end, open another: it opens scrolled down (405 px of 405 on "Defaults").
// settings-ui.js renders every section into the same .st-content box (renderContent) and never resets its scrollTop.
// Fix: .st-content.scrollTop = 0 when the section changes (S.section differs from the one last drawn). One line.
layoutTest('L6d Settings: each section opens at its top, no double scrollbars, no sideways scroll', async (lab) => {
  const page = lab.page;
  await openSeeded(lab, 4);
  await page.viewport(1400, 600);
  await settle(500);
  await clickHere(page, '#openSettings');
  await page.waitFor(`document.body.classList.contains('settings-open') && !!document.querySelector('.st-content')`, 8000, 'settings open');
  await settle(1200);
  const problems: string[] = [];
  const s0 = sweepProblems(await sweep(page), ['pre', 'code', 'table']);
  if (s0.length) problems.push(`first section: ${s0.join('; ')}`);
  const n = await page.eval<number>(`document.querySelectorAll('.st-nav button').length`);
  assert(n >= 3, `settings sections: ${n}`);
  await page.eval(`document.querySelector('.st-content').scrollTop = 99999`);
  for (let i = 1; i < Math.min(n, 7); i++) {
    await page.eval(`document.querySelectorAll('.st-nav button')[${i}].click()`);
    await settle(700);
    const r = await page.eval<{ top: number; sh: number; ch: number; label: string }>(`(() => { const c = document.querySelector('.st-content');
      return { top: Math.round(c.scrollTop), sh: c.scrollHeight, ch: c.clientHeight, label: document.querySelectorAll('.st-nav button')[${i}].textContent.trim().slice(0, 30) }; })()`);
    if (r.top > 2) problems.push(`"${r.label}" opened scrolled down ${r.top} px (of ${r.sh - r.ch})`);
    const s = sweepProblems(await sweep(page), ['pre', 'code', 'table']);
    if (s.length) problems.push(`"${r.label}": ${s.join('; ')}`);
    await page.eval(`document.querySelector('.st-content').scrollTop = 99999`);
  }
  assert(!problems.length, problems.join('\n'));
});

// ---- L7. split view: the side pane's copy of a chat ------------------------------------------------------------------------------

async function openSplit(lab: Lab) {
  const page = lab.page;
  const a = await lab.chat();
  await a.start();
  seed(a, 30, 'Alpha');
  a.say('Alpha done ALPHAEND');
  const b = await lab.chat();
  await b.start();
  seed(b, 30, 'Beta');
  b.say('Beta done BETAEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await lab.select(b);
  await shown(page, 'BETAEND');
  await settle(800);
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(a.key)}, 'row')`);
  await page.waitFor(`document.querySelectorAll('.mirror-msgs').length === 1 && document.querySelector('.mirror-msgs').children.length > 5`, 15000, 'a side pane with a copy of a chat');
  await settle(1500);
  const key = await page.eval<string>(`document.querySelector('.mirror-msgs').dataset.mirror`);
  return { a, b, side: key === a.key ? a : b };
}

const mirrorM = (page: Page) => page.eval<{ top: number; sh: number; ch: number; gap: number; cw: number }>(`(() => {
  const b = document.querySelector('.mirror-msgs');
  return { top: Math.round(b.scrollTop), sh: b.scrollHeight, ch: b.clientHeight, gap: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight), cw: b.clientWidth };
})()`);

// Fails today: a split side pane that was at the bottom is left 322 px above it when the window narrows (rows wrap taller), and
// the next update leaves it 349 px above: it no longer follows. chat.js paintMirror decides "at the end" only when it paints
// (mirrorBottom, ~4126: gap < 48), so a resize that grows the copy turns following off for good. Fix: a ResizeObserver on each
// .mirror-msgs that keeps a box that was at the end at the end (remember atEnd on scroll; the same rule as the width watcher).
layoutTest('L7a split view: the side pane at the bottom stays at the bottom when the window narrows, and keeps following', async (lab) => {
  const page = lab.page;
  const { side } = await openSplit(lab);
  const m0 = await mirrorM(page);
  assert(m0.gap <= 1, `the side pane starts at the bottom: ${JSON.stringify(m0)}`);
  await page.viewport(1250, 900);
  await settle(1200);
  const m1 = await mirrorM(page);
  side.say('\n\nNew in the side pane SIDENEW');
  await page.waitFor(`document.querySelector('.mirror-msgs').textContent.includes('SIDENEW')`, 15000, 'the update in the side pane');
  await settle(1200);
  const m2 = await mirrorM(page);
  assert(m1.gap <= 1 && m2.gap <= 1, `after narrowing: ${JSON.stringify(m1)}; after the next update: ${JSON.stringify(m2)}`);
});

layoutTest('L7b split view: no double scrollbars and no sideways scroll with two panes, at 1600 and 1250 px', async (lab) => {
  const page = lab.page;
  await openSplit(lab);
  const problems: string[] = [];
  for (const w of [1600, 1250]) {
    await page.viewport(w, 900);
    await settle(1000);
    const bad = sweepProblems(await sweep(page), ['pre', 'code', 'table', 'div.ws-tabs']);
    if (bad.length) problems.push(`${w} px: ${bad.join('; ')}`);
  }
  assert(!problems.length, problems.join('\n'));
});

// ---- L8. the terminal dock -----------------------------------------------------------------------------------------------------

layoutTest('L8 terminal dock open, window resized: the chat above still follows; no page scroll, no double scrollbars', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab);
  await clickHere(page, '.aib-term-toggle');
  await page.waitFor('!!document.getElementById("terminalDock") && document.getElementById("terminalDock").getBoundingClientRect().height > 50', 15000, 'terminal dock');
  await settle(1500);
  await keepsFollowing(page, () => page.viewport(1300, 800), 'window 1300x800 with the dock open');
  const bad = sweepProblems(await sweep(page), ['pre', 'code', 'table', 'div.xterm']);
  assert(!bad.length, bad.join('; '));
  chat.end();
});

// Fails today: with a doc or artifact open (right column 920 px) on a 1600 px window the chat column is ~440 px wide, the message
// box's buttons (Attach, Interrupt, Queue) sit beside the text box and leave it ~150 px: its placeholder wraps to two lines and
// the empty box shows its own scrollbar. chat.css #promptForm (~431) lays the buttons out in a row at every width. Fix: under ~560 px of
// chat column, put .composer-actions under the text box (a container query on the chat column), or shorten the placeholder.
layoutTest('L2p with the viewer open (chat column ~440 px), the empty message box has no scrollbar of its own', async (lab) => {
  const page = lab.page;
  const chat = await openSeeded(lab, 4);
  const id = await agentPublishes(lab, chat, 'Narrow composer', 'NARROWCOMP');
  await clickHere(page, `#messages a.artifact-link[data-artifact-id="${id}"]`);
  await waitViewing(page, true);
  const p = await page.eval<Record<string, number>>(`(() => { const t = document.getElementById('prompt'); return { w: t.clientWidth, sh: t.scrollHeight, ch: t.clientHeight, col: Math.round(document.getElementById('messages').getBoundingClientRect().width) }; })()`);
  assert(p.sh <= p.ch + 1, `the empty message box scrolls: ${p.sh}/${p.ch} px, ${p.w} px wide in a ${p.col} px chat column`);
  chat.end();
});
