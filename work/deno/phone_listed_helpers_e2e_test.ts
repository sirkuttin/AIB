/**
 * Left-list helpers on the phone (owner 2026-11-27): a listed helper is a card under its main chat, indented, with the phone's
 * usual card; an unlisted helper stays out of the list. Headless Chrome, in-process AIB with a fake agent host, a paired phone.
 *
 * Run (from app): deno test -A ../work/deno/phone_listed_helpers_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone } from './_remote_fixture.ts';
import { liveChat, v2Aib } from './_remote_v2b.ts';
import { phonePage } from './_remote_phone_page.ts';
import { Registry } from '../../app/server/swarm/registry.ts';

type Json = Record<string, unknown>;
const NOW = Date.now() / 1000;
const record = (id: string, title: string, chat: string, parent: string, project: string, listed: boolean, at: number): Json => ({
  id, title, project,
  parent: { live: parent, lasting: `claude:sess-${parent}` },
  chat: { live: chat, lasting: `claude:sess-${chat}`, provider: 'claude', model: '', mode: 'auto' },
  brief: { goal: 'g', owns: [], avoid: [], done_when: 'd', reply_with: 'r', test_cmd: 'none', read_only: false, context_files: [] },
  picked_by: 'rule', rule: 'tests', why: '', worktree: { path: '', branch: `studio/helper-${id}`, base: 'main', start: '' },
  state: 'working', reason: '', createdAt: at, turnEndedAt: 'x', cursor: 0, reports: [], merge: null, notes: [],
  ...(listed ? { listed: true, listedAt: at } : {}),
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: 'phone: listed helpers are cards under their main chat, indented; unlisted helpers stay out',
  ignore: !browserPath,
  async fn() {
    const s = await v2Aib();
    const browser = await Browser.launch();
    try {
      const role = { swarm: { role: 'helper' } };
      s.chats.push(
        liveChat('c-main', s.project, { breadth: { sessionInfo: { title: 'Main chat' } } }),
        liveChat('c-other', s.project, { breadth: { sessionInfo: { title: 'Other chat' } } }),
        liveChat('c-h1', s.project, { ...role, breadth: { sessionInfo: { title: 'Listed one' } } }),
        liveChat('c-h2', s.project, { ...role, breadth: { sessionInfo: { title: 'Listed two' } } }),
        liveChat('c-h3', s.project, { ...role, breadth: { sessionInfo: { title: 'Hidden helper' } } }),
      );
      const registry = new Registry(s.state);
      await registry.update('h_1', () => <never> record('h_1', 'Listed one', 'c-h1', 'c-main', s.project, true, NOW - 200));
      await registry.update('h_2', () => <never> record('h_2', 'Listed two', 'c-h2', 'c-main', s.project, true, NOW - 100));
      await registry.update('h_3', () => <never> record('h_3', 'Hidden helper', 'c-h3', 'c-main', s.project, false, NOW - 300));
      const phone = await pairPhone(s);
      const ph = await phonePage(browser, s, phone);
      await ph.waitFor('document.querySelectorAll(".ph-cw").length >= 4', 15000, 'the cards');
      const view = await ph.eval<{ ids: string[]; subs: string[]; left: Record<string, number> }>(`(() => {
        const cws = [...document.querySelectorAll('.ph-cw')];
        const id = (n) => n.querySelector('.ph-card').dataset.chat;
        return { ids: cws.map(id), subs: cws.filter((n) => n.classList.contains('ph-helper-row')).map(id),
          left: Object.fromEntries(cws.map((n) => [id(n), Math.round(n.querySelector('.ph-card').getBoundingClientRect().left)])) };
      })()`);
      const at = view.ids.indexOf('c-main');
      assertEquals(view.ids.slice(at, at + 3), ['c-main', 'c-h1', 'c-h2'], 'under the main chat, in the order they were listed: ' + JSON.stringify(view.ids));
      assertEquals(view.subs, ['c-h1', 'c-h2']);
      assert(!view.ids.includes('c-h3'), 'an unlisted helper stays out');
      assertEquals(view.left['c-h1'] - view.left['c-main'], 24, 'indented 24 px: ' + JSON.stringify(view.left));
      assertEquals(view.left['c-other'], view.left['c-main'], 'other chats are not indented');
      assertEquals(ph.errors, [], 'console errors');
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
