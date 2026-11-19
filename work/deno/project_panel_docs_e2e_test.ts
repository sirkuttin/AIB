/**
 * The project right panel is the PROJECT's, in the real page (code review M1 and M2; aib-shared/reviews/project-right-panel-code-review.md).
 *
 *   M1  A chat whose folder is a git worktree of the project is filed under the project; its Changes tab, its tab badge and its Docs
 *       list are the project folder's, never the worktree's.
 *   M2  The Docs tab on the New chat page of another project lists THAT project's docs, and "+ New doc" makes the doc in that project
 *       (it used to keep the previous project's chat: wrong list, and the new doc landed in the previous project).
 *
 * A real Studio in this process (fake agent host, temp state folder, free port; never the live ports), headless Chrome or Edge.
 * Project A is a git repository with a real worktree; project B is an added folder. Run (from outputs/agent-studio):
 *   deno test -A ../../work/deno/project_panel_docs_e2e_test.ts   (ignored without Chrome or Edge or git)
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pc, remoteStudio } from './_remote_fixture.ts';
import { git, HAVE_GIT, write } from './_git_repo.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

function addChat(s: Awaited<ReturnType<typeof remoteStudio>>, n: number, title: string, cwd: string) {
  s.chats.push({
    id: 'c' + n, provider: 'claude', sessionId: 'sess-' + n, cwd, busy: false, closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: new Date(Date.now() - n * 60_000).toISOString(), busySince: null },
    subagents: {}, breadth: { sessionInfo: { title } },
    events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }], permissions: [], elicitations: [],
  });
}
async function openChat(page: Page, key: string) {
  const sel = `button.connection[data-key="${key}"]`;
  await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 20000, `sidebar row ${key}`);
  await page.click(sel);
  await page.waitFor(`document.querySelector(${JSON.stringify(sel)})?.classList.contains('selected')`, 20000, `${key} open`);
}
const rows = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('#docsPane .dt-row')].map((r) => r.dataset.doc)`);
const waitRows = (page: Page, want: string[], what: string) =>
  page.waitFor(`JSON.stringify([...document.querySelectorAll('#docsPane .dt-row')].map((r) => r.dataset.doc)) === ${JSON.stringify(JSON.stringify(want))}`, 25000, what).catch(
    async (e) => {
      throw new Error(`${e.message}: ${JSON.stringify(await rows(page))} ${JSON.stringify(await page.eval('AgentDocsTabUI.state()'))} ${await page.eval<string>(`document.getElementById('docsPane').innerText`)}`);
    },
  );

Deno.test({
  name: 'project panel: a worktree chat keeps Changes, the badge and Docs the project\'s; the Docs tab of another project\'s New chat page lists that project\'s docs and "+ New doc" writes there',
  ignore: !browserPath || !HAVE_GIT,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const s = await remoteStudio(undefined, undefined, { saved: true });
    const appDir = `${s.root}${SEP}projects${SEP}app`;
    const wt = `${s.root}${SEP}projects${SEP}app-wt`;
    const other = s.project; // an added project
    Deno.mkdirSync(appDir, { recursive: true });
    git(appDir, 'init', '-q', '-b', 'main');
    write(`${appDir}${SEP}app.txt`, 'one\ntwo\n');
    git(appDir, 'add', '-A');
    git(appDir, 'commit', '-q', '-m', 'base');
    git(appDir, 'worktree', 'add', '-q', '-b', 'side', wt, 'HEAD');
    write(`${appDir}${SEP}app.txt`, 'one\ntwo\nMAIN EDIT\n');
    write(`${wt}${SEP}app.txt`, 'one\ntwo\nWT EDIT\n');
    write(`${wt}${SEP}wt-a.txt`, 'a\n');
    write(`${wt}${SEP}wt-b.txt`, 'b\n');
    addChat(s, 1, 'App chat', appDir);
    addChat(s, 9, 'Worktree chat', wt);
    addChat(s, 2, 'Shop chat', other);
    // docs: Alpha in project A, Beta in project B (made through each project's own chat)
    assertEquals((await pc(s, 'POST', '/api/live/docs/open', { id: 'c1', name: 'Alpha', create: '' }))[0], 200);
    assertEquals((await pc(s, 'POST', '/api/live/docs/open', { id: 'c2', name: 'Beta', create: '' }))[0], 200);
    const browser = await Browser.launch();
    try {
      const page: Page = await browser.open('about:blank', 1600, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor(`StudioChat.state.conversations.length === 3`, 25000, 'three chats listed');
      const pkOf = (sess: string) => page.eval<string>(`AgentWorkspaceUI.projectKeyOf(StudioChat.state.conversations.find((c) => c.sessionId === ${JSON.stringify(sess)}))`);
      const pkA = await pkOf('sess-1'), pkWt = await pkOf('sess-9'), pkB = await pkOf('sess-2');
      assert(pkA && pkB && pkA !== pkB, `two projects: ${pkA} ${pkB}`);
      assertEquals(pkWt, pkA, 'a chat in a git worktree of the project is filed under the project');
      // --- M1: open the chat in the worktree: Changes, badge and Docs are the project's
      await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pkA)})`);
      await openChat(page, 'claude:sess-1');
      await page.click('#paneTab-changes');
      const main = `[...document.querySelectorAll('#projectChanges > .cg-sec[data-sec="main"] .cg-file, #projectChanges > .cg-sec[data-sec="main"] .cg-doc')].map((b) => b.dataset.path || b.textContent).sort()`;
      await page.waitFor(`document.querySelector('#paneTab-changes .pane-badge')?.hidden === false && ${main}.includes('app.txt')`, 30000, "main shows the project folder's edit").catch(async (e) => {
        throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('changesPane').innerText`)}`);
      });
      const projectMain = await page.eval<string[]>(main);
      const projectBadge = await page.eval<string>(`document.querySelector('#paneTab-changes .pane-badge').textContent`);
      assert(!projectMain.some((p) => p.startsWith('wt-')), `the project's files only: ${projectMain}`);
      // the same project, from a chat that works in the worktree
      await openChat(page, 'claude:sess-9');
      await new Promise((r) => setTimeout(r, 3500)); // a re-read has happened (sync() reads at once)
      assertEquals(await page.eval<string[]>(main), projectMain, "the worktree chat's Changes is the project's: the same rows");
      assertEquals(await page.eval<string>(`document.querySelector('#paneTab-changes .pane-badge').textContent`), projectBadge, 'the same badge');
      const ROW = '#projectChanges > .cg-sec[data-sec="main"] .cg-file[data-path="app.txt"]';
      if ((await page.eval<string>(`document.querySelector('${ROW}').getAttribute('aria-expanded')`)) !== 'true') await page.click(ROW);
      await page.waitFor(`/MAIN EDIT/.test(document.getElementById('projectChanges').innerText)`, 20000, "main's diff is the project's").catch(async (e) => {
        throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('projectChanges').innerText.slice(0, 600)`)} ${await page.eval<string>(`JSON.stringify(performance.getEntriesByType('resource').map((x) => x.name).filter((n) => n.includes('changes/file')))`)}`);
      });
      assert(!(await page.eval<boolean>(`/WT EDIT/.test(document.getElementById('projectChanges').innerText)`)), "the worktree's edit is not shown");
      await page.click('#paneTab-docs');
      await waitRows(page, ['alpha'], "Docs lists the project's docs from a worktree chat");
      // --- M2: another project's New chat page
      await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pkB)})`);
      await page.waitFor(`AgentDocsTabUI.state().project === ${JSON.stringify(pkB)}`, 15000, 'the Docs tab follows the project');
      // the New chat page of project B (no chat of B is open)
      if (await page.eval<boolean>(`!!document.getElementById('new') && !document.querySelector('button.connection.selected[data-key="claude:sess-2"]')`)) {
        await page.eval(`document.getElementById('new').click()`);
      }
      assertEquals(await page.eval<string>(`AgentChangesUI._live().chatId()`), '', 'a New chat page: no chat is open (the Docs tab must not keep the previous project\'s)');
      await page.click('#paneTab-docs'); // each project keeps its own tab: show Docs
      await waitRows(page, ['beta'], "Docs lists project B's docs, not A's");
      // "+ New doc" creates in B
      await page.click('#docsPane .dt-newrow');
      await page.waitFor(`!!document.querySelector('#docsPane .dt-name')`, 10000, 'the name field');
      await page.eval(`(() => { const i = document.querySelector('#docsPane .dt-name'); i.value = 'Gamma'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      const inB = () => (Deno.statSync(`${other}${SEP}aib-docs`).isDirectory ? [...Deno.readDirSync(`${other}${SEP}aib-docs`)].map((e) => e.name) : []);
      const start = Date.now();
      while (!inB().includes('gamma') && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 200));
      assert(inB().includes('gamma'), `Gamma is in project B's aib-docs: ${inB()}`);
      const inA = [...Deno.readDirSync(`${appDir}${SEP}aib-docs`)].map((e) => e.name);
      assert(!inA.includes('gamma'), `nothing was made in project A: ${inA}`);
      assert(!(await Deno.stat(`${wt}${SEP}aib-docs`).then(() => true, () => false)), 'nor in the worktree');
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
