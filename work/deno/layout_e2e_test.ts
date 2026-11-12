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
import { browserPath, type Chat, clickHere, following, Lab, m, type Page, settle, shown, sleep, wheel } from './_scroll_lab.ts';

const ALL = Deno.env.get('AIB_LAYOUT_ALL') === '1';

/** Tests that fail today: each is a finding in the layout audit (the comment in the test gives the cause and the fix). */
export const KNOWN_FAILING = new Set<string>([]);

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
  await clickHere(page, '.ar-empty .ar-doc');
  await waitViewing(page, true);
  const moved = await rowMoved(page, a);
  const y = await m(page);
  assert(!moved, `${moved} (scrollTop ${x.top} -> ${y.top}, scrollHeight ${x.height} -> ${y.height})`);
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
