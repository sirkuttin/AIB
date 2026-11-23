/**
 * Helpers from other agents show in their MAIN chat's Activity section (owner, 2026-11-23), in the same list as its subagents:
 *   - a row labelled with the agent ("Claude Code · strata", "Codex"), with the subagent rows' look and states (Working, Waiting on you,
 *     Completed in the folded "N finished" line);
 *   - counted in the head's "N subagents";
 *   - a click opens the helper's history in the panel (HELPER HISTORY), never the chat itself; the accent, the open chat and the panel
 *     width stay as they are;
 *   - the helper chat is not a section of its own, working or idle.
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), scripted live chats, the helper registry written
 * into the lab's state folder (as /api/live/swarm reads it), headless Chrome or Edge.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/swarm_activity_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems } from './_scroll_lab.ts';
import { Registry } from '../../outputs/agent-studio/server/swarm/registry.ts';

type Json = Record<string, unknown>;

const record = (id: string, title: string, chat: Chat, parent: Chat, state: string, provider: string, label: string, project: string): Json => ({
  id,
  title,
  project,
  parent: { live: parent.id, lasting: parent.key },
  chat: { live: chat.id, lasting: chat.key, provider, model: '', mode: 'auto', ...(label ? { label } : {}) },
  brief: { goal: 'g', owns: [`${id}/`], avoid: [], done_when: 'd', reply_with: 'r', test_cmd: 'none', read_only: false, context_files: [] },
  picked_by: 'rule',
  rule: 'tests',
  why: '',
  worktree: { path: '', branch: `studio/helper-${id}`, base: 'main', start: '' },
  state,
  reason: '',
  createdAt: Date.now() / 1000 - 300,
  endedAt: state === 'merged' ? Date.now() / 1000 - 60 : undefined,
  turnEndedAt: 'x', // the lab's helper chats are scripted: never reported by the swarm watcher
  cursor: 0,
  reports: [],
  merge: null,
  notes: [],
});

const SEC = (key: string) => `#projectActivity > .sp-grp[data-key=${JSON.stringify(key)}]`;
const IDLE = (key: string) => `#projectActivity > .sp-idle-list > .sp-idle[data-key=${JSON.stringify(key)}]`;

Deno.test({
  name: 'swarm activity: helpers are rows in their main chat\'s section (labelled, counted, openable), never sections of their own',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900);
    try {
      const page = lab.page;
      const main = await lab.chat();
      await main.start();
      main.say('MAINEND');
      const work = await lab.chat(), ask = await lab.chat(), done = await lab.chat();
      await work.start();
      work.say('WORKEND');
      await ask.start();
      ask.step({ ask: 'Run npm test' });
      await done.start();
      done.say('DONEEND');
      done.end();
      await lab.select(main);
      await page.waitFor(`!!document.querySelector(${JSON.stringify(SEC(main.key))})`, 20000, 'the main chat has its section');
      // before the helpers are known to the registry the chats look like any working chats
      await page.waitFor(`!!document.querySelector(${JSON.stringify(SEC(work.key))})`, 20000, 'a plain chat has its own section');

      const project = lab.fx.workspace;
      const registry = new Registry(lab.fx.state);
      await registry.update('h_work0001', () => <never> record('h_work0001', 'Login bug', work, main, 'working', 'claude', 'Claude Code · strata', project));
      await registry.update('h_ask00001', () => <never> record('h_ask00001', 'Settings page', ask, main, 'working', 'codex', 'Codex', project));
      await registry.update('h_done0001', () => <never> record('h_done0001', 'Old migration', done, main, 'merged', 'codex', 'Codex', project));

      await page.waitFor(`!document.querySelector(${JSON.stringify(SEC(work.key))}) && !document.querySelector(${JSON.stringify(SEC(ask.key))})`, 20000, 'helper chats leave the sections');
      assert(await page.eval<boolean>(`!document.querySelector(${JSON.stringify(IDLE(done.key))})`), 'a finished helper is not an idle section either');
      assertEquals(await page.eval<string[]>(`[...document.querySelectorAll('#projectActivity > .sp-grp')].map((g) => g.dataset.key)`), [main.key]);

      const cards = `(() => { const box = document.querySelector(${JSON.stringify(SEC(main.key))} + ' .sp-subs');
        return { cards: [...box.querySelectorAll('.subagent-card:not(.sa-toggle)')].map((c) => ({
          title: c.querySelector('.sa-title')?.textContent, meta: c.querySelector('.sa-meta')?.textContent || '', cls: c.className, text: c.textContent })),
          fold: box.querySelector('.sa-toggle')?.textContent || '' }; })()`;
      await page.waitFor(`(${cards}).cards.length >= 2`, 20000, 'two helper cards');
      const first = await page.eval<{ cards: { title: string; meta: string; cls: string; text: string }[]; fold: string }>(cards);
      const byTitle = (t: string) => first.cards.find((c) => c.title === t)!;
      assert(byTitle('Login bug').meta.includes('Claude Code · strata'), `labelled with the agent: ${byTitle('Login bug').meta}`);
      assert(byTitle('Settings page').meta.includes('Codex'), byTitle('Settings page').meta);
      assert(byTitle('Login bug').cls.includes('sa-working'), 'a working helper is a working card');
      assert(first.fold.includes('1 finished'), `the merged helper folds into "1 finished": ${first.fold}`);
      // waiting on you: its chat has an open approval (needs you)
      await page.waitFor(`(${cards}).cards.find((c) => c.title === 'Settings page')?.cls.includes('sa-waiting')`, 20000, 'waiting on you');
      assert((await page.eval<{ cards: { title: string; text: string }[] }>(cards)).cards.find((c) => c.title === 'Settings page')!.text.includes('Waiting on you'));
      // counted in the head
      const head = await page.eval<string>(`document.querySelector(${JSON.stringify(SEC(main.key) + ' .sp-sub')}).textContent`);
      assert(/2 subagents/.test(head), `the head counts the working helpers: ${head}`);
      // the folded line expands to the finished helper
      await page.click(`${SEC(main.key)} .sa-toggle`);
      await page.waitFor(`(${cards}).cards.some((c) => c.title === 'Old migration')`, 10000, 'the finished helper row');

      // a click opens its history in the panel: no chat switch, no accent move, no width change
      const before = await page.eval<Json>(`({ sel: document.querySelector('button.connection.selected')?.dataset.key,
        width: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
        focus: document.querySelector('#projectActivity > .sp-focus')?.dataset.key })`);
      const clicked = await page.eval<boolean>(`(() => { const c = [...document.querySelectorAll(${JSON.stringify(SEC(main.key))} + ' .subagent-card')]
        .find((n) => n.querySelector('.sa-title')?.textContent === 'Login bug'); if (!c) return false; c.click(); return true; })()`);
      assert(clicked, 'the helper card is there to click');
      await page.waitFor(`!document.getElementById('subchatPane').hidden && document.getElementById('subchatTitle').textContent === 'Login bug'`, 10000, 'the history opens');
      assertEquals(await page.eval<string>(`document.getElementById('inspectorEyebrow').textContent`), 'HELPER HISTORY');
      assert((await page.eval<string>(`document.getElementById('subchatStatus').textContent`)).includes('helper chat'));
      const after = await page.eval<Json>(`({ sel: document.querySelector('button.connection.selected')?.dataset.key,
        width: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
        focus: document.querySelector('#projectActivity > .sp-focus')?.dataset.key })`);
      assertEquals(after, before, 'the open chat, the accent and the panel width did not change');
      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
      const owner = await ownerProblems(page);
      assert(!owner, owner);
    } finally {
      await lab.close();
    }
  },
});
