/**
 * Left-list helpers (owner 2026-11-27), the page. A listed helper is the SAME chat card as every chat, under its main chat's card,
 * 24 px in, and nothing else differs. Listed in start order (never re-sorted by activity), still listed after it finished. Activity's
 * helper card has "Add to chat list" on its TITLE ROW; once listed it has no button at all. The listed card's ⋯ menu has "Move to
 * Activity list"; every chat's menu and Ctrl+K have "Fork this session". Archiving the main chat archives its listed helpers. A listed
 * helper that needs you is one row in the inbox.
 *
 * A real AIB (the scroll lab: temp state folder, free port; never the live ports), scripted live chats, the helper registry written
 * into the lab's state folder (as /api/live/swarm reads it), headless Chrome or Edge.
 *
 * Run (from app): deno test -A ../work/deno/left_list_helpers_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, sleep } from './_scroll_lab.ts';
import { Registry } from '../../app/server/swarm/registry.ts';

type Json = Record<string, unknown>;
const NOW = Date.now() / 1000;

const record = (id: string, title: string, chat: Chat, parent: Chat, state: string, provider: string, project: string, createdAt: number, listed: boolean): Json => ({
  id,
  title,
  project,
  parent: { live: parent.id, lasting: parent.key },
  chat: { live: chat.id, lasting: chat.key, provider, model: '', mode: 'auto', label: 'Codex' },
  brief: { goal: 'g', owns: [`${id}/`], avoid: [], done_when: 'd', reply_with: 'r', test_cmd: 'none', read_only: false, context_files: [] },
  picked_by: 'rule',
  rule: 'tests',
  why: '',
  worktree: { path: '', branch: `studio/helper-${id}`, base: 'main', start: '' },
  state,
  reason: '',
  createdAt,
  endedAt: state === 'merged' ? NOW - 60 : undefined,
  turnEndedAt: 'x', // the lab's helper chats are scripted: never reported by the swarm watcher
  cursor: 0,
  reports: [],
  merge: null,
  notes: [],
  ...(listed ? { listed: true, listedAt: createdAt } : {}),
});

const ROW = (key: string) => `#connections button.connection[data-key=${JSON.stringify(key)}]`;
const SEC = (key: string) => `#projectActivity > .sp-grp[data-key=${JSON.stringify(key)}]`;
/** The keys of the left list's cards, top to bottom. */
const ORDER = `[...document.querySelectorAll('#connections button.connection[data-key]')].map((b) => b.dataset.key)`;
/** The Activity buttons "Add to chat list" of one main chat's section, with the title of the card each sits on (title row only). */
const ADDS = (main: string) => `(() => [...document.querySelectorAll(${JSON.stringify(SEC(main) + ' .sa-list')})].map((b) => ({
  title: b.closest('.subagent-card')?.querySelector('.sa-title')?.textContent, inTitleRow: b.parentElement.classList.contains('sa-l1') && !!b.parentElement.querySelector('.sa-title') && !!b.parentElement.querySelector('.sa-dot'),
  text: b.textContent })))()`;

Deno.test({
  name: 'left-list helpers: listed helpers sit under their main chat, 24 px in, in start order; Activity add and move back; menu and Ctrl+K fork; archive takes them; inbox counts once',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900, undefined, { fastList: true });
    try {
      const page = lab.page;
      const project = lab.fx.workspace;
      const registry = new Registry(lab.fx.state);
      const main = await lab.chat();
      await main.start();
      main.say('MAINEND'); // its turn stays open: a working chat has an Activity section
      const a = await lab.chat(), b = await lab.chat(), c = await lab.chat();
      await a.start();
      a.say('WORKEND'); // helper A works the whole time (Activity only at first)
      await b.start();
      b.step({ ask: 'Run npm test' }); // helper B needs you
      await c.start();
      c.say('DONEEND');
      c.end();
      await lab.select(main);
      await page.waitFor(`!!document.querySelector(${JSON.stringify(SEC(main.key))})`, 20000, 'the main chat has its section');
      // A is only in Activity (the default); B and C are listed. Start order: A, then B, then C.
      await registry.update('h_aaaa0001', () => <never> record('h_aaaa0001', 'Login bug', a, main, 'working', 'codex', project, NOW - 300, false));
      await registry.update('h_bbbb0001', () => <never> record('h_bbbb0001', 'Settings page', b, main, 'working', 'codex', project, NOW - 200, true));
      await registry.update('h_cccc0001', () => <never> record('h_cccc0001', 'Old migration', c, main, 'merged', 'codex', project, NOW - 100, true));
      await page.waitFor(`JSON.stringify(${ORDER}) === ${JSON.stringify(JSON.stringify([main.key, b.key, c.key]))}`, 25000, 'only the main chat and its listed helpers are in the left list');
      assert(!(await page.eval<string[]>(ORDER)).includes(a.key), 'a helper that is not listed stays out of the left list');
      assertEquals(await page.eval<string[]>(ORDER), [main.key, b.key, c.key], 'under the main chat, in start order');

      // the SAME card: same markup and classes as the main chat's card, no label, no arrow, no badge; only the 24 px indent differs
      const look = `(() => { const q = (k) => document.querySelector('#connections button.connection[data-key="' + k + '"]');
        const card = (k) => { const btn = q(k), row = btn.parentElement, r = btn.getBoundingClientRect();
          return { left: Math.round(r.left * 10) / 10, rowClass: row.className.replace(/\s*helper-listed/, '').trim(), btnClass: btn.className.replace(/\s*selected/, '').trim(),
            parts: [...btn.children].map((n) => n.tagName + '.' + n.className.split(' ')[0]).join(' '), text: btn.innerText, height: Math.round(r.height), font: getComputedStyle(btn.querySelector('.connection-title')).fontSize,
            siblings: row.children.length }; };
        return { main: card(${JSON.stringify(main.key)}), b: card(${JSON.stringify(b.key)}), c: card(${JSON.stringify(c.key)}) }; })()`;
      const cards = await page.eval<Record<string, { left: number; rowClass: string; btnClass: string; parts: string; text: string; height: number; font: string; siblings: number }>>(look);
      assertEquals(Math.round((cards.b.left - cards.main.left) * 10) / 10, 24, `a listed helper's card is 24 px in: ${JSON.stringify([cards.main.left, cards.b.left])}`);
      assertEquals(cards.c.left, cards.b.left, 'every listed helper has the same indent');
      for (const k of ['b', 'c'] as const) {
        assertEquals(cards[k].rowClass, cards.main.rowClass, `${k}: the same row classes as a chat card`);
        assertEquals(cards[k].font, cards.main.font, `${k}: the same title size`);
        assertEquals(cards[k].siblings, cards.main.siblings, `${k}: the same pieces (card and ⋯)`);
        assert(!/↳|Helper|helper/.test(cards[k].text), `${k}: no arrow, no "Helper" label: ${JSON.stringify(cards[k].text)}`);
      }
      assertEquals(cards.b.parts.split(' ').length, cards.main.parts.split(' ').length, 'the same parts in the card: no badge or branch line added');
      assert(!(await page.eval<boolean>(`!!document.querySelector('#connections .helper-badge, #connections .helper-branch, #connections .helper-guide')`)));
      assert(!/helper/i.test(cards.main.text), 'no chip or count of helpers on the main card: ' + cards.main.text);

      // Activity: only the unlisted helper A offers "Add to chat list", on its title row; no "Remove from chat list" anywhere
      await page.waitFor(`(${ADDS(main.key)}).length === 1`, 20000, 'one Add to chat list button');
      const adds = await page.eval<{ title: string; inTitleRow: boolean; text: string }[]>(ADDS(main.key));
      assertEquals(adds.map((x) => [x.title, x.text, x.inTitleRow]), [['Login bug', 'Add to chat list', true]]);
      const onTitleRow = await page.eval<boolean>(`(() => { const t = document.querySelector(${JSON.stringify(SEC(main.key) + ' .sa-list')}); const l1 = t.parentElement;
        return l1.classList.contains('sa-l1') && !!l1.querySelector('.sa-title') && l1.querySelectorAll('.sa-line').length === 0; })()`);
      assert(onTitleRow, 'the button is a child of the title row itself (no new row)');
      assert(!(await page.eval<boolean>(`document.getElementById('projectActivity').innerText.includes('Remove from chat list')`)), 'Activity never offers Remove from chat list');

      // order never follows activity: a listed helper that starts working again stays where it was
      c.step({ u: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'again' } } });
      await sleep(1500);
      assertEquals(await page.eval<string[]>(ORDER), [main.key, b.key, c.key], 'order is stable while helpers work and finish');

      // finished helpers stay listed: B finishes and is merged, still there
      await registry.patch('h_bbbb0001', { state: 'merged', endedAt: NOW } as never);
      b.end();
      await sleep(2500);
      assertEquals(await page.eval<string[]>(ORDER), [main.key, b.key, c.key], 'a finished helper stays listed');

      // Add to chat list: A joins the left list, first in start order (it started first); its Activity row has no button now
      await page.click(`${SEC(main.key)} .sa-list`);
      await page.waitFor(`(${ORDER}).includes(${JSON.stringify(a.key)})`, 20000, 'A is listed');
      assertEquals(await page.eval<string[]>(ORDER), [main.key, a.key, b.key, c.key], 'A is listed in start order, never at the top by activity');
      await page.waitFor(`(${ADDS(main.key)}).length === 0`, 20000, 'no button once listed');
      assert(!(await page.eval<boolean>(`/Remove from chat list/.test(document.body.innerText)`)));
      const saved = (await lab.web.get('/api/live/swarm'))[1].helpers as Json[];
      assertEquals(saved.filter((h) => h.listed === true).map((h) => h.id).sort(), ['h_aaaa0001', 'h_bbbb0001', 'h_cccc0001']);
      assertEquals((await page.eval<{ left: number }>(`(() => ({ left: document.querySelector(${JSON.stringify(ROW(a.key))}).getBoundingClientRect().left }))()`)).left, cards.b.left, 'A has the same indent');

      // the listed card's ⋯ menu: Move to Activity list; a main chat's menu has Fork this session and no Move
      const menuOf = async (key: string): Promise<string[]> => {
        await page.eval(`document.querySelector(${JSON.stringify(ROW(key))}).parentElement.querySelector('[data-menu-key]').click()`);
        await page.waitFor(`!!document.getElementById('organizeMenu')`, 5000, 'the chat menu');
        return await page.eval<string[]>(`[...document.querySelectorAll('#organizeMenu button')].map((x) => x.textContent)`);
      };
      const closeMenu = () => page.eval(`document.getElementById('organizeMenu')?.remove()`);
      const mainMenu = await menuOf(main.key);
      assert(mainMenu.includes('Fork this session') && !mainMenu.includes('Move to Activity list'), JSON.stringify(mainMenu));
      await closeMenu();
      const helperMenu = await menuOf(a.key);
      assert(helperMenu.includes('Move to Activity list') && helperMenu.includes('Fork this session'), JSON.stringify(helperMenu));
      await page.click('#organizeMenu button[data-item=unlist]');
      await page.waitFor(`!(${ORDER}).includes(${JSON.stringify(a.key)})`, 20000, 'A moved back to Activity');
      assertEquals(await page.eval<string[]>(ORDER), [main.key, b.key, c.key]);
      await page.waitFor(`(${ADDS(main.key)}).length === 1`, 20000, 'A offers Add to chat list again');
      await page.click(`${SEC(main.key)} .sa-list`); // listed again for the rest
      await page.waitFor(`(${ORDER}).includes(${JSON.stringify(a.key)})`, 20000, 'A listed again');

      // Ctrl+K runs "Fork this session" on the open chat; the menu click posts the fork of that chat
      await page.eval(`window.__forks = []; const f = window.fetch; window.fetch = function (u, i) { if (String(u).includes('swarm/fork')) window.__forks.push(JSON.parse(i.body)); return f.apply(this, arguments); }`);
      await page.key('k', 2);
      await page.waitFor(`!!document.querySelector('dialog[open], .switcher, #switcher')`, 5000, 'the switcher');
      await page.type('fork');
      await page.waitFor(`/Fork this session/.test(document.body.innerText)`, 5000, 'Ctrl+K offers Fork this session');
      await page.key('Escape');
      const forkItem = await menuOf(main.key);
      assert(forkItem.includes('Fork this session'));
      await page.click('#organizeMenu button[data-item=fork]');
      await page.waitFor(`window.__forks.length === 1`, 10000, 'the fork request');
      assertEquals(await page.eval<Json>(`window.__forks[0]`), { id: main.id, title: await page.eval<string>(`window.__forks[0].title`) });
      assert((await page.eval<string>(`window.__forks[0].title`)).length > 0, 'the fork request carries the chat name');

      // the inbox counts the listed helper's approval once: B needs you only if open; use A-like check on the helper that asks
      const inbox = (await lab.web.get('/api/live/inbox'))[1] as { rows: { key: string; section: string }[]; count: number };
      const needing = inbox.rows.filter((r) => r.section === 'needs').map((r) => r.key);
      assertEquals(needing.filter((k) => k === b.key).length <= 1, true, 'one inbox row per chat');
      assert(!needing.includes(main.key), "the main chat is not made to need you by its helper's request");
      assertEquals(inbox.count, new Set(needing).size, 'the count is the number of distinct chats that need you');

      // archiving the main chat archives its listed helpers
      await page.eval(`document.querySelector(${JSON.stringify(ROW(main.key))}).parentElement.querySelector('[data-menu-key]').click()`);
      await page.click('#organizeMenu button[data-item=archive]');
      const keep = await page.waitFor(`!!document.querySelector('dialog[open] button, .organize-dialog button')`, 5000, 'the live-chat dialog').catch(() => null);
      if (keep) {
        await page.eval(`[...document.querySelectorAll('dialog[open] button, .organize-dialog button')].find((x) => /Keep running and archive/.test(x.textContent))?.click()`);
      }
      const archived = async () => {
        const entries = (await lab.web.get('/api/live/conversation-state'))[1].entries as Record<string, Json>;
        return [main.key, a.key, b.key, c.key].map((k) => !!entries[k]?.archivedAt);
      };
      for (let i = 0; i < 100 && !(await archived()).every(Boolean); i++) await sleep(100);
      assertEquals(await archived(), [true, true, true, true], 'the main chat and its three listed helpers are archived');

      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
      const owner = await ownerProblems(page);
      assert(!owner, owner);
    } finally {
      await lab.close();
    }
  },
});
