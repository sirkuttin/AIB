/**
 * Helper chats in the page (owner decision 2026-11-23). A real AIB (the scroll lab: temp state folder, free port; never the live
 * ports), scripted live chats, the helper registry written into the lab's state folder, headless Chrome or Edge:
 *  - a helper chat (working, waiting, or done and merged) is not in the left chat list, but Ctrl+K finds it, named after its job
 *    ("Fix login (Codex)") and labelled "helper of <main chat>"; an owner's rename wins;
 *  - a helper waiting on a plain approval has small Allow / Deny buttons on its Activity row, and its MAIN chat shows the approval
 *    card labelled `Codex helper "Fix login" requests approval`; answering from either answers the helper's own agent and clears
 *    both; the open chat, the accent and the panel width do not move;
 *  - a question, and a risky request, have an Open button on the row instead of Allow / Deny.
 *
 * Run (from app): deno task test --jobs 2 swarm_approvals_e2e   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, type Page } from './_scroll_lab.ts';
import { Registry } from '../../app/server/swarm/registry.ts';

type Json = Record<string, unknown>;

const record = (id: string, title: string, chat: Chat, parent: Chat, state: string, label: string, project: string): never =>
  (<never> {
    id,
    title,
    project,
    parent: { live: parent.id, lasting: parent.key },
    chat: { live: chat.id, lasting: chat.key, provider: 'codex', model: '', mode: 'auto', label },
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

/** Ctrl+K, type a query, read the results ({title, sub}), close it. */
async function search(page: Page, q: string): Promise<{ title: string; sub: string }[]> {
  await page.key('k', 2);
  await page.waitFor('!!document.querySelector("#switcher[open] .switcher-input")', 5000, 'the command bar');
  await page.eval(`(() => { const i = document.querySelector('#switcher .switcher-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await new Promise((r) => setTimeout(r, 250));
  const out = await page.eval<{ title: string; sub: string }[]>(`[...document.querySelectorAll('#switcherList .switcher-item')]
    .map((li) => ({ title: li.querySelector('.switcher-title')?.textContent || '', sub: li.querySelector('.switcher-sub')?.textContent || '' }))`);
  await page.key('Escape');
  await page.waitFor('!document.querySelector("#switcher[open]")', 5000, 'the command bar closed');
  return out;
}

Deno.test({
  name: 'swarm approvals: helper chats leave the left list but not search; approvals are answered from the Activity row or the main chat',
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
      const work = await lab.chat(), risky = await lab.chat(), quest = await lab.chat(), done = await lab.chat(), own = await lab.chat();
      await work.start();
      work.step({ ask: 'Run npm test' });
      await risky.start();
      risky.step({ ask: 'git push origin main' });
      await quest.start();
      quest.step({ elicit: 'Which database should the helper use?' });
      await done.start();
      done.say('DONEEND');
      done.end();
      await own.start();
      own.say('OWNEND');
      await lab.select(main);
      await page.waitFor(`!!document.querySelector('button.connection[data-key="${work.key}"]')`, 20000, 'before the registry, a helper looks like any chat');
      // the owner renamed this one before it was named
      await lab.web.post('chat-name', { key: own.key, name: 'My own name', cwd: lab.fx.workspace });

      const project = lab.fx.workspace;
      const registry = new Registry(lab.fx.state);
      await registry.update('h_work0001', () => record('h_work0001', 'Fix login', work, main, 'working', 'Codex', project));
      await registry.update('h_risk0001', () => record('h_risk0001', 'Release push', risky, main, 'working', 'Claude Code · strata', project));
      await registry.update('h_ques0001', () => record('h_ques0001', 'Pick database', quest, main, 'working', 'Codex', project));
      await registry.update('h_done0001', () => record('h_done0001', 'Old migration', done, main, 'merged', 'Codex', project));
      await registry.update('h_own00001', () => record('h_own00001', 'Rename me', own, main, 'working', 'Codex', project));

      // 1. the left list leaves every helper chat out (working, waiting, done and merged); the lead chat stays
      const left = `[...document.querySelectorAll('#connections button.connection')].map((b) => b.dataset.key)`;
      await page.waitFor(`!(${left}).some((k) => k !== ${JSON.stringify(main.key)})`, 30000, 'the helper chats leave the left list');
      assertEquals(await page.eval<string[]>(left), [main.key]);

      // 2. search still finds them, named after the job and labelled with their main chat; an owner rename wins
      let found: { title: string; sub: string }[] = [];
      for (let i = 0; i < 20; i++) {
        found = await search(page, 'Fix login');
        if (found.some((r) => r.title === 'Fix login (Codex)')) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const hit = found.find((r) => r.title === 'Fix login (Codex)');
      assert(hit, `search finds the helper by its name: ${JSON.stringify(found)}`);
      assert(/helper of /.test(hit.sub), `labelled as a helper of its main chat: ${hit.sub}`);
      const strata = await search(page, 'Release push');
      assert(strata.some((r) => r.title === 'Release push (Claude Code · strata)'), JSON.stringify(strata));
      const merged = await search(page, 'Old migration');
      assert(merged.some((r) => r.title === 'Old migration (Codex)' && /helper of /.test(r.sub)), `a merged helper is found too: ${JSON.stringify(merged)}`);
      const renamed = await search(page, 'My own name');
      assert(renamed.some((r) => r.title === 'My own name'), `the owner's rename wins: ${JSON.stringify(renamed)}`);
      assert(!(await search(page, 'Rename me')).some((r) => r.title === 'Rename me (Codex)'), 'the job name did not replace the rename');

      // 3. Activity rows: Allow / Deny for the plain approval, Open for the risky request and the question
      const rowsOf = `(() => { const box = document.querySelector(${JSON.stringify(SEC(main.key))} + ' .sp-subs');
        const out = {}; for (const w of box ? box.querySelectorAll('.sa-askwrap') : []) {
          out[w.querySelector('.sa-title')?.textContent || ''] = [...w.querySelectorAll('.sa-askbtn')].map((b) => b.textContent); }
        return out; })()`;
      await page.waitFor(`(${rowsOf})['Fix login']?.length === 2 && (${rowsOf})['Release push']?.length === 1 && (${rowsOf})['Pick database']?.length === 1`, 30000, 'the row buttons');
      assertEquals(await page.eval<Json>(rowsOf), { 'Fix login': ['Allow', 'Deny'], 'Release push': ['Open'], 'Pick database': ['Open'] });
      assert(!(await page.eval<boolean>(`!!document.querySelector('.sa-askbtn[data-act=allow]') && document.querySelectorAll('.sa-ask').length > 3`)), 'no buttons on rows that wait on nothing');

      // 4. the main chat shows each helper approval as a labelled card (the question gets no card: its row has Open)
      const cards = `[...document.querySelectorAll('#approvals .approval-helper')].map((c) => ({ head: c.querySelector('h3').textContent, key: c.dataset.key,
        options: [...c.querySelectorAll('button')].map((b) => b.textContent) }))`;
      await page.waitFor(`(${cards}).length === 2`, 30000, 'two helper cards in the main chat');
      const shown = await page.eval<{ head: string; options: string[] }[]>(cards);
      const heads = shown.map((c) => c.head).sort();
      assertEquals(heads, ['Claude Code · strata helper “Release push” requests approval', 'Codex helper “Fix login” requests approval']);
      const fix = shown.find((c) => c.head.includes('Fix login'))!;
      assert(fix.options.includes('Allow once') && fix.options.includes('Reject') && fix.options.includes('Cancel request'), `the helper's own options: ${fix.options}`);

      // 5. answer from the row (Allow): the helper's agent gets allow_once; row buttons and the card clear; nothing else moves
      const before = await page.eval<Json>(`({ sel: document.querySelector('button.connection.selected')?.dataset.key,
        width: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
        focus: document.querySelector('#projectActivity > .sp-focus')?.dataset.key })`);
      assertEquals(
        await page.eval<boolean>(`(() => { const w = [...document.querySelectorAll(${JSON.stringify(SEC(main.key) + ' .sa-askwrap')})].find((x) => x.querySelector('.sa-title')?.textContent === 'Fix login');
          const b = w && w.querySelector('.sa-askbtn[data-act=allow]'); if (!b) return false; b.click(); return true; })()`),
        true,
      );
      const waited = async (c: Chat) => {
        for (let i = 0; i < 100 && !c.answers().length; i++) await new Promise((r) => setTimeout(r, 100));
        return c.answers();
      };
      const answered = await waited(work);
      assertEquals(answered.length, 1, 'the helper was answered once');
      assertEquals((answered[0].result as Json).outcome, { outcome: 'selected', optionId: 'yes' });
      await page.waitFor(`(${rowsOf})['Fix login'] === undefined && !(${cards}).some((c) => c.head.includes('Fix login'))`, 30000, 'the row buttons and the card clear');
      const after = await page.eval<Json>(`({ sel: document.querySelector('button.connection.selected')?.dataset.key,
        width: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
        focus: document.querySelector('#projectActivity > .sp-focus')?.dataset.key })`);
      assertEquals(after, before, 'the open chat, the accent and the panel width did not move');

      // 6. answer from the main chat's card (Reject on the risky helper): the helper's agent gets reject_once; its row and card clear
      assertEquals(await page.eval<boolean>(`(() => { const c = [...document.querySelectorAll('#approvals .approval-helper')].find((x) => x.querySelector('h3').textContent.includes('Release push'));
        const b = c && [...c.querySelectorAll('button')].find((x) => x.textContent === 'Reject'); if (!b) return false; b.click(); return true; })()`), true);
      const rejected = await waited(risky);
      assertEquals(rejected.length, 1);
      assertEquals((rejected[0].result as Json).outcome, { outcome: 'selected', optionId: 'no' });
      await page.waitFor(`(${cards}).length === 0 && (${rowsOf})['Release push'] === undefined`, 30000, 'the card and the Open button clear');
      assertEquals(quest.answers(), [], 'the question was not answered by anything');

      // 7. a question: Open shows its history in the panel (never the chat), still no Allow / Deny
      assertEquals((await page.eval<Json>(rowsOf))['Pick database'], ['Open']);
      await page.eval(`(() => { const w = [...document.querySelectorAll(${JSON.stringify(SEC(main.key) + ' .sa-askwrap')})].find((x) => x.querySelector('.sa-title')?.textContent === 'Pick database');
        w.querySelector('.sa-askbtn').click(); })()`);
      await page.waitFor(`!document.getElementById('subchatPane').hidden && document.getElementById('subchatTitle').textContent.startsWith('Pick database')`, 10000, 'its history opens');
      assertEquals(await page.eval<string>(`document.querySelector('button.connection.selected')?.dataset.key`), main.key, 'the chat did not change');
      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
      const owner = await ownerProblems(page);
      assert(!owner, owner);
    } finally {
      await lab.close();
    }
  },
});
