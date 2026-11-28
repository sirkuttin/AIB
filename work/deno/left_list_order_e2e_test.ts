/**
 * Drag to reorder the left chat list (owner-approved 2026-11-28), the page. Every listed chat can be dragged up or down inside its
 * section; the order is saved per chat in AIB's state (studio-conversations.json: a rank) and kept after a reload or restart, seen by
 * another window; nothing re-sorts by itself afterwards (a new chat goes to the top). A listed helper moves among its main chat's
 * helpers only and stays under its main chat; a main chat takes its listed helpers with it. A drop line shows while dragging, Esc
 * cancels, Alt+Up / Alt+Down move the focused chat, and a card dropped on the chat area still opens in a split pane.
 *
 * A real AIB (the scroll lab: temp state folder, free port; never the live ports), scripted live chats, the helper registry written
 * into the lab's state folder, real mouse and key events in headless Chrome or Edge.
 *
 * Run (from app): deno test -A ../work/deno/left_list_order_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, sleep } from './_scroll_lab.ts';
import type { Page } from './_doc_browser.ts';
import { Registry } from '../../app/server/swarm/registry.ts';
import { ConversationState } from '../../app/server/state/conversations.ts';

type Json = Record<string, unknown>;
const NOW = Date.now() / 1000;

const record = (id: string, title: string, chat: Chat, parent: Chat, project: string, createdAt: number): Json => ({
  id,
  title,
  project,
  parent: { live: parent.id, lasting: parent.key },
  chat: { live: chat.id, lasting: chat.key, provider: 'claude', model: '', mode: 'auto', label: 'Claude' },
  brief: { goal: 'g', owns: [`${id}/`], avoid: [], done_when: 'd', reply_with: 'r', test_cmd: 'none', read_only: false, context_files: [] },
  picked_by: 'rule',
  rule: 'tests',
  why: '',
  worktree: { path: '', branch: `studio/helper-${id}`, base: 'main', start: '' },
  state: 'working',
  reason: '',
  createdAt,
  turnEndedAt: 'x',
  cursor: 0,
  reports: [],
  merge: null,
  notes: [],
  listed: true,
  listedAt: createdAt,
});

const ORDER = `[...document.querySelectorAll('#connections button.connection[data-key]')].map((b) => b.dataset.key)`;
const BTN = (key: string) => `#connections button.connection[data-key=${JSON.stringify(key)}]`;
/** The top and bottom of a chat's card and its listed helpers' cards (one unit), and the card's centre. */
const RECT = (key: string) => `(() => { const b = document.querySelector(${JSON.stringify(BTN(key))}); const row = b.closest('.conversation-row');
  let last = row, n = row.nextElementSibling; while (n && n.dataset.parent === ${JSON.stringify(key)}) { last = n; n = n.nextElementSibling; }
  const a = row.getBoundingClientRect(), z = last.getBoundingClientRect(), c = b.getBoundingClientRect();
  return { top: a.top, bottom: z.bottom, left: a.left, cx: c.left + c.width / 2, cy: c.top + c.height / 2 }; })()`;
const LINE = `(() => { const l = document.querySelector('.reorder-line'); if (!l || l.style.display === 'none') return null;
  const r = l.getBoundingClientRect(); return { top: r.top, h: r.height, left: r.left, w: r.width }; })()`;

type Rect = { top: number; bottom: number; left: number; cx: number; cy: number };
const rect = (page: Page, key: string) => page.eval<Rect>(RECT(key));
const mouse = (page: Page, type: string, x: number, y: number) =>
  page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });

/** Press on a card and move far enough that the drag starts. */
async function lift(page: Page, key: string): Promise<Rect> {
  const r = await rect(page, key);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.cx, y: r.cy });
  await mouse(page, 'mousePressed', r.cx, r.cy);
  await mouse(page, 'mouseMoved', r.cx, r.cy + 4);
  await mouse(page, 'mouseMoved', r.cx, r.cy + 9);
  return r;
}
/** Move the held card to above or below another chat's unit (its card and helpers). */
async function over(page: Page, key: string, where: 'above' | 'below', x?: number): Promise<void> {
  const t = await rect(page, key);
  const y = where === 'above' ? t.top + 3 : t.bottom - 3;
  await mouse(page, 'mouseMoved', x ?? t.cx, y - 2);
  await mouse(page, 'mouseMoved', x ?? t.cx, y);
}

/** The expected order after moving a unit, from the list's order and who is whose helper. */
function expectAfter(order: string[], helpers: Record<string, string>, move: string, where: 'above' | 'below', target: string): string[] {
  const units: string[][] = [];
  for (const k of order) {
    if (helpers[k]) units.find((u) => u[0] === helpers[k])!.push(k);
    else units.push([k]);
  }
  if (helpers[move]) { // a helper moves among its main chat's helpers
    const unit = units.find((u) => u[0] === helpers[move])!;
    const kids = unit.slice(1).filter((k) => k !== move);
    kids.splice(kids.indexOf(target) + (where === 'above' ? 0 : 1), 0, move);
    unit.splice(1, unit.length, ...kids);
    return units.flat();
  }
  const mine = units.find((u) => u[0] === move)!;
  const rest = units.filter((u) => u !== mine);
  const at = rest.findIndex((u) => u[0] === target);
  rest.splice(where === 'above' ? at : at + 1, 0, mine);
  return rest.flat();
}
const sameOrder = (page: Page, want: string[], ms = 25000) =>
  page.waitFor(`JSON.stringify(${ORDER}) === ${JSON.stringify(JSON.stringify(want))}`, ms, `the list reads ${want.map((k) => k.slice(-4)).join(' ')}`);

Deno.test({
  name: 'left list: drag reorders chats, saved per project and kept; helpers stay under their main chat; Esc cancels; Alt+Up/Down; split drop still works; other windows follow',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900, undefined, { fastList: true });
    let other: Page | null = null;
    try {
      const page = lab.page;
      const project = lab.fx.workspace;
      const registry = new Registry(lab.fx.state);
      const mains: Chat[] = [];
      for (let i = 0; i < 3; i++) {
        const c = await lab.chat();
        await c.start();
        c.say('ok');
        c.end();
        mains.push(c);
      }
      const helperChats: Chat[] = [];
      for (let i = 0; i < 2; i++) {
        const c = await lab.chat();
        await c.start();
        c.end();
        helperChats.push(c);
      }
      await lab.select(mains[0]);
      await page.waitFor(`${ORDER}.length === 5`, 25000, 'five chats listed');
      const mainKeys = new Set(mains.map((m) => m.key));
      const first = (await page.eval<string[]>(ORDER)).filter((k) => mainKeys.has(k));
      const parent = mains.find((m) => m.key === first[1])!; // the middle chat gets two listed helpers
      const [h1, h2] = helperChats;
      await registry.update('h_oooo0001', () => <never> record('h_oooo0001', 'Helper one', h1, parent, project, NOW - 200));
      await registry.update('h_oooo0002', () => <never> record('h_oooo0002', 'Helper two', h2, parent, project, NOW - 100));
      const helpers: Record<string, string> = { [h1.key]: parent.key, [h2.key]: parent.key };
      let order = [first[0], first[1], h1.key, h2.key, first[2]];
      await sameOrder(page, order);
      // every save of the order the page makes (the hook is put on again after a reload; earlier saves are counted in `kept`)
      let kept = 0;
      const hook = () => page.eval(`window.__posts = []; const f = window.fetch; window.fetch = function (u, o) { if (o && o.method === 'POST' && String(u).includes('conversation-state')) window.__posts.push(String(o.body)); return f.apply(this, arguments); }; 1`);
      await hook();
      const posts = async () => [...Array(kept).fill(''), ...(await page.eval<string[]>(`window.__posts`))];

      // 1. drag a main chat from the top to the bottom: the line shows while dragging; its helpers are not touched; it is saved
      const [a, b, c] = [first[0], first[1], first[2]];
      await lift(page, a);
      await over(page, c, 'below');
      const line = await page.eval<{ top: number; h: number; left: number; w: number } | null>(LINE);
      assert(line, 'a drop line shows while dragging');
      const cr = await rect(page, c);
      assert(Math.abs(line!.top + line!.h / 2 - cr.bottom) <= 2, `the line sits under the last card: ${line!.top} vs ${cr.bottom}`);
      assert(line!.h >= 2 && line!.w > 100, 'the line is a visible bar across the card');
      assertEquals(await page.eval<string[]>(ORDER), order, 'nothing moves until the drop');
      await mouse(page, 'mouseReleased', cr.cx, cr.bottom - 3);
      order = expectAfter(order, helpers, a, 'below', c);
      await sameOrder(page, order);
      assertEquals(await page.eval(`${LINE}`), null, 'the line is gone after the drop');
      assertEquals((await posts()).length, 1, 'one save');
      assertEquals(JSON.parse((await posts())[0]), { action: 'reorder', keys: [b, c, a] }, 'the main chats only, in the new order');
      assertEquals(order.slice(0, 3), [b, h1.key, h2.key], 'the main chat took the helpers position: still right under it');

      // 2. saved: reload the page, and a fresh server state (a restart) reads the same ranks
      kept = (await posts()).length;
      await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
      await sameOrder(page, order);
      await hook();
      const stored = new ConversationState(lab.fx.state).public().entries;
      assertEquals([stored[b]?.rank, stored[c]?.rank, stored[a]?.rank], [1, 2, 3], 'the order is in AIB state, per chat');
      assertEquals(stored[h1.key]?.rank, undefined, 'helpers are not ranked until a helper is moved');

      // 3. a second window sees the same order, and follows a later change
      other = await lab.browser.open('about:blank', 1400, 900);
      await other.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__aibTestListScale = 5;' });
      await other.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
      await sameOrder(other, order);

      // 4. a helper moves among its main chat's helpers only: dragging it onto another main chat changes nothing
      await lift(page, h1.key);
      await over(page, c, 'above', undefined);
      assertEquals(await page.eval(`${LINE}`), null, 'no line over another main chat: a helper stays under its own');
      const cc = await rect(page, c);
      await mouse(page, 'mouseReleased', cc.cx, cc.top + 3);
      await sleep(600);
      assertEquals(await page.eval<string[]>(ORDER), order, 'a helper dropped on another chat does not move');
      assertEquals((await posts()).length, 1, 'nothing saved');
      await lift(page, h1.key);
      await over(page, h2.key, 'below');
      assert(await page.eval(`${LINE}`), 'a line shows among its own helpers');
      const hr = await rect(page, h2.key);
      await mouse(page, 'mouseReleased', hr.cx, hr.bottom - 3);
      order = expectAfter(order, helpers, h1.key, 'below', h2.key);
      await sameOrder(page, order);
      assertEquals(order.slice(0, 3), [b, h2.key, h1.key], 'the helpers swapped and are still under their main chat');
      assertEquals(JSON.parse((await posts())[1]).keys, [h2.key, h1.key]);

      // 5. a main chat dragged to the top takes its helpers with it
      await lift(page, b);
      await over(page, a, 'below');
      const ar = await rect(page, a);
      await mouse(page, 'mouseReleased', ar.cx, ar.bottom - 3);
      order = expectAfter(order, helpers, b, 'below', a);
      await sameOrder(page, order);
      assertEquals(order, [c, a, b, h2.key, h1.key], 'its two helpers moved with it, in their order');

      // 6. Esc cancels: nothing moves, nothing is saved, no line; the release after Esc opens nothing
      const saves = (await posts()).length;
      await lift(page, c);
      await over(page, a, 'below');
      assert(await page.eval(`${LINE}`), 'the line shows before Esc');
      await page.key('Escape');
      assertEquals(await page.eval(`${LINE}`), null, 'Esc removes the line');
      const er = await rect(page, a);
      await mouse(page, 'mouseReleased', er.cx, er.bottom - 3);
      await sleep(600);
      assertEquals(await page.eval<string[]>(ORDER), order, 'Esc: the order is unchanged');
      assertEquals((await posts()).length, saves, 'Esc: nothing saved');
      assertEquals(await page.eval<number>(`document.querySelectorAll('.reorder-lift').length`), 0, 'Esc: no card left lifted');

      // 7. keyboard: Alt+Down / Alt+Up move the focused chat one place, focus stays on it; plain arrows still only move focus
      await page.eval(`document.querySelector(${JSON.stringify(BTN(c))}).focus(); 1`);
      await page.key('ArrowDown', 1);
      order = expectAfter(order, helpers, c, 'below', a);
      await sameOrder(page, order);
      assertEquals(await page.eval<string>(`document.activeElement?.dataset?.key || ''`), c, 'focus stays on the moved chat');
      await page.key('ArrowUp', 1);
      order = expectAfter(order, helpers, c, 'above', a);
      await sameOrder(page, order);
      await page.key('ArrowUp', 1); // already first: nothing happens
      await sleep(400);
      assertEquals(await page.eval<string[]>(ORDER), order, 'Alt+Up on the first chat does nothing');
      await page.eval(`document.querySelector(${JSON.stringify(BTN(h2.key))}).focus(); 1`);
      await page.key('ArrowDown', 1);
      order = expectAfter(order, helpers, h2.key, 'below', h1.key);
      await sameOrder(page, order);
      assertEquals(order.slice(2, 5), [b, h1.key, h2.key], 'Alt+Down moves a helper among its own helpers');
      await page.key('ArrowDown', 1); // last helper: it never leaves its main chat
      await sleep(400);
      assertEquals(await page.eval<string[]>(ORDER), order);

      // the other window follows the new order without a reload
      await sameOrder(other, order, 40000);

      // 8. nothing re-sorts by activity: a chat that starts working again stays where it is
      mains[0].step({ u: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'again' } } });
      await sleep(1500);
      assertEquals(await page.eval<string[]>(ORDER), order, 'activity does not move cards');

      // 9. a new chat goes to the top of its section
      const fresh = await lab.chat();
      await fresh.start();
      fresh.end();
      await sameOrder(page, [fresh.key, ...order], 40000);

      // 10. dragging a card onto the chat area still opens it in a split pane (and does not reorder)
      await lab.select({ key: order[0] });
      const before = (await posts()).length;
      assertEquals(await page.eval<boolean>(`!!window.AgentSplitUI.active()`), false);
      const src = await lift(page, order[order.length - 1]);
      const chat = await page.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById('chat').getBoundingClientRect(); return { x: r.right - 40, y: r.top + r.height / 2 }; })()`);
      await mouse(page, 'mouseMoved', (src.cx + chat.x) / 2, chat.y);
      await mouse(page, 'mouseMoved', chat.x, chat.y);
      assertEquals(await page.eval(`${LINE}`), null, 'no reorder line over the chat area');
      await mouse(page, 'mouseReleased', chat.x, chat.y);
      await page.waitFor(`!!window.AgentSplitUI.active()`, 15000, 'the card opened in a split pane');
      assertEquals((await posts()).length, before, 'a split drop saves no order');

      assertEquals(page.errors.length, 0, `console errors: ${page.errors.join(' | ')}`);
      const owner = await ownerProblems(page);
      assert(!owner, owner);
    } finally {
      try {
        await other?.close();
      } catch { /* gone */ }
      await lab.close();
    }
  },
});
