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
import { browserPath, type Chat, Lab, ownerProblems, settle, sleep } from './_scroll_lab.ts';
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
      await page.waitFor(`!document.getElementById('subchatPane').hidden && document.getElementById('subchatTitle').textContent === 'Login bug (Claude Code · strata)'`, 10000, 'the history opens');
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

/* A finished helper and a finished subagent look and fold the same everywhere (owner, 2026-11-23: "the helper never went into the
   finished list"): one "N finished" fold with the same row look and the same done dot, in a working chat's section and in an idle
   chat's expanded section. */
Deno.test({
  name: 'swarm activity: a merged helper and a finished subagent fold together into "2 finished", the same dot, in a working and in an idle section',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900, undefined, { fastList: true });
    try {
      const page = lab.page;
      const project = lab.fx.workspace;
      const registry = new Registry(lab.fx.state);
      const sub = (c: Chat, tag: string, desc: string) =>
        c.step({ u: { sessionUpdate: 'subagent_update', subagent: { sessionId: `${tag}-sub`, description: desc, state: 'completed' } } });
      // the idle main chat: a finished subagent, a merged helper, then its turn ends
      const idle = await lab.chat();
      await idle.start();
      idle.say('IDLEEND');
      sub(idle, 'idle', 'Idle subagent job');
      idle.end();
      for (let i = 0; i < 300; i++) {
        const s = await lab.web.state(idle.id);
        if (!s.busy && JSON.stringify(s.events || []).includes('Idle subagent job')) break;
        await sleep(50);
      }
      // the working main chat: the same, its turn stays open
      const busy = await lab.chat();
      await busy.start();
      busy.say('BUSYEND');
      sub(busy, 'busy', 'Busy subagent job');
      const hIdle = await lab.chat(), hBusy = await lab.chat();
      for (const h of [hIdle, hBusy]) {
        await h.start();
        h.say('HELPEREND');
        h.end();
      }
      await lab.select(busy);
      await page.waitFor(`!!document.querySelector(${JSON.stringify(SEC(busy.key))})`, 20000, 'the working chat has its section');
      await registry.update('h_idle0001', () => <never> record('h_idle0001', 'Idle helper job', hIdle, idle, 'merged', 'codex', 'Codex', project));
      await registry.update('h_busy0001', () => <never> record('h_busy0001', 'Busy helper job', hBusy, busy, 'merged', 'codex', 'Codex', project));
      const IDLE_HEAD = `${IDLE(idle.key)} > .sp-ihead`;
      await page.waitFor(`document.querySelector(${JSON.stringify(IDLE_HEAD + ' .sp-count')})?.textContent === '2 finished'`, 25000, 'the idle head counts "2 finished"');
      await page.click(IDLE_HEAD);

      // every card of a box: title, class list, and the colour of its dot
      const rows = (box: string) => `(() => { const b = document.querySelector(${JSON.stringify(box)}); if (!b) return null;
        const t = b.querySelector('.sa-toggle');
        return { fold: t ? t.innerText.replace(/\\s+/g, ' ').trim() : '', open: t?.getAttribute('aria-expanded') || '',
          working: [...b.querySelectorAll('.subagent-card.sa-working')].length,
          cards: [...b.querySelectorAll('.subagent-card')].map((c) => ({ title: c.querySelector('.sa-title')?.textContent || '', cls: c.className.replace(/ ?selected/, ''),
            dot: getComputedStyle(c.querySelector('.sa-dot')).backgroundColor + '|' + getComputedStyle(c.querySelector('.sa-dot')).borderTopColor })) }; })()`;
      type Rows = { fold: string; open: string; working: number; cards: { title: string; cls: string; dot: string }[] };
      const boxes = { idle: `${IDLE(idle.key)} .sp-subs`, busy: `${SEC(busy.key)} .sp-subs` };
      const seen: Record<string, Rows> = {};
      for (const [where, box] of Object.entries(boxes)) {
        await page.waitFor(`(${rows(box)})?.fold === '▸ 2 finished'`, 20000, `${where}: the fold row "2 finished"`).catch(async (e) => {
          throw new Error(`${e.message}: ${JSON.stringify(await page.eval(rows(box)))}`);
        });
        assertEquals((await page.eval<Rows>(rows(box))).cards.length, 0, `${where}: folded rows are not listed flat`);
        await page.click(`${box} .sa-toggle`);
        await page.waitFor(`(${rows(box)})?.cards.length === 2`, 10000, `${where}: both finished rows under the fold`);
        seen[where] = await page.eval<Rows>(rows(box));
        assertEquals(seen[where].working, 0, `${where}: nothing shows as working`);
        assertEquals(seen[where].cards.map((c) => c.title).sort(), where === 'idle' ? ['Idle helper job', 'Idle subagent job'] : ['Busy helper job', 'Busy subagent job']);
        const [a, b] = seen[where].cards;
        assertEquals(a.cls, b.cls, `${where}: helper and subagent rows have the same classes`);
        assertEquals(a.dot, b.dot, `${where}: the same done dot`);
        assert(/sa-finished/.test(a.cls) && /sa-completed/.test(a.cls) && !/sa-working/.test(a.cls), `${where}: a done row: ${a.cls}`);
      }
      assertEquals(seen.idle.cards[0].cls, seen.busy.cards[0].cls, 'the same row look in both sections');
      assertEquals(seen.idle.cards[0].dot, seen.busy.cards[0].dot, 'the same done dot in both sections');
      // clicking a merged helper row opens its own history in the panel, with no error banner
      const openRow = (box: string, title: string) => page.eval<boolean>(`(() => { const c = [...document.querySelectorAll(${JSON.stringify(box + ' .subagent-card')})]
        .find((n) => n.querySelector('.sa-title')?.textContent === ${JSON.stringify(title)}); if (!c) return false; c.click(); return true; })()`);
      const banner = () => page.eval<string>(`document.getElementById('error').hidden ? '' : document.getElementById('error').textContent`);
      assert(await openRow(boxes.busy, 'Busy helper job'), 'the merged helper row is there');
      await page.waitFor(`!document.getElementById('subchatPane').hidden && document.getElementById('inspectorEyebrow').textContent === 'HELPER HISTORY' && /Busy helper job/.test(document.getElementById('subchatTitle').textContent)`, 10000, 'the merged helper history opens');
      await page.waitFor(`document.getElementById('submessages').textContent.includes('HELPEREND')`, 10000, "the helper's own messages show").catch(async (e) => {
        throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('submessages').textContent`)}`);
      });
      await settle(1500);
      assertEquals(await banner(), '', 'no error banner after opening a merged helper');
      // a forced failure of that read shows inside the panel, not as the page banner, and clears when the read works again
      assert(await openRow(boxes.busy, 'Busy helper job'), 'the open row toggles closed');
      await page.waitFor(`document.getElementById('subchatPane').hidden`, 10000, 'the history closes');
      const sess = hBusy.key.split(':')[1];
      await page.eval(`(() => { window.__realFetch = window.fetch; window.fetch = (u, ...r) => { const t = decodeURIComponent(String(u?.url || u));
        return /api.(transcript|live.events|live.state)/.test(t) && (t.includes(${JSON.stringify(sess)}) || t.includes('id=' + ${JSON.stringify(hBusy.id)}))
          ? Promise.resolve(new Response('{"error":"forced"}', { status: 500 })) : window.__realFetch(u, ...r); }; })()`);
      assert(await openRow(boxes.busy, 'Busy helper job'), 'the row opens again');
      await page.waitFor(`!!document.querySelector('#submessages .sub-error')`, 20000, 'the forced failure shows inside the panel').catch(async (e) => {
        throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('submessages').textContent`)}`);
      });
      assertEquals(await banner(), '', 'a failed read never becomes the page banner');
      await page.eval(`window.fetch = window.__realFetch`);
      await page.waitFor(`!document.querySelector('#submessages .sub-error')`, 20000, 'the inline error clears once the read works');
      assertEquals(await banner(), '', 'still no banner');
      // the idle section's heading counts the working ones, as in a working section
      assertEquals(await page.eval<string>(`document.querySelector(${JSON.stringify(IDLE(idle.key) + ' .sp-label')}).textContent`), 'Subagents0 working');
      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
      const owner = await ownerProblems(page);
      assert(!owner, owner);
    } finally {
      await lab.close();
    }
  },
});
