/**
 * The right panel's Changes tab against a real Git repository (right panel audit, test build 4, 2026-11-16).
 *
 * 1. A folder chat with several changed files at the default column width: the counts in the bar ("8 files +14 −11") are whole;
 *    the longer folder heading gives way with an ellipsis and keeps its full text as the tooltip. (Before: the heading took the
 *    room and the counts were cut to "8 files +14 …", the removed lines gone.)
 * 2. A folder chat that is not working, on its Changes tab: an edit another chat makes in the project folder shows up by itself.
 *    (Before: the tab polled only while its own agent worked, so the list stayed stale until you switched chats.)
 * 3. Split view: an open diff follows its file when the file changes. (Before: the row's numbers changed, the diff stayed old.)
 * 4. Split view: a section counts every changed file (also past the 300 it lists), and two chats in the project folder, which see
 *    the same files, count them once in the tab badge. (Before: the head said "300 files" and the badge doubled to 640.)
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), scripted live chats, headless Chrome or
 * Edge, Git.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/changes_panel_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, type Page, settle, shown } from './_scroll_lab.ts';

function changesTest(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1600, 900);
      try {
        await fn(lab);
        assertEquals(lab.page.errors, [], 'no console errors');
        const owner = await ownerProblems(lab.page);
        assert(!owner, owner);
      } finally {
        await lab.close();
      }
    },
  });
}

function git(cwd: string, ...args: string[]) {
  const o = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd, stdout: 'null', stderr: 'piped' })
    .outputSync();
  if (!o.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(o.stderr)}`);
}
function write(path: string, text: string) {
  Deno.mkdirSync(path.replace(/\\[^\\]+$/, ''), { recursive: true });
  Deno.writeTextFileSync(path, text);
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

/** The workspace as a repository with one commit (src/app.ts, src/gone.ts). */
function repo(ws: string) {
  git(ws, 'init', '-q', '-b', 'main');
  write(`${ws}\\src\\app.ts`, lines(40, 'app'));
  write(`${ws}\\src\\gone.ts`, lines(10, 'gone'));
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'base');
}

/** A folder chat that said its line and finished its turn, open, on the Changes tab. */
async function folderChat(lab: Lab, word: string): Promise<Chat> {
  const c = await lab.chat();
  await c.start();
  c.say(`Folder chat ${word}`);
  c.end();
  await lab.select(c);
  await shown(lab.page, word);
  await lab.page.eval(`document.getElementById('paneTab-changes').click()`);
  return c;
}
const rows = (page: Page, box = '#changesPane > .cg-files') =>
  page.eval<string[]>(`[...document.querySelectorAll('${box} .cg-file')].map((b) => b.dataset.path)`);

changesTest('Changes, folder chat: the counts stay whole at the default width; the heading gives way and keeps its tooltip', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}\\src\\app.ts`, lines(40, 'app').replace('app 5\n', 'app five\nadded\n'));
  Deno.removeSync(`${ws}\\src\\gone.ts`);
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) write(`${ws}\\notes\\${n}.md`, lines(2, n));
  await folderChat(lab, 'COUNTS');
  await page.waitFor(`document.querySelectorAll('#changesPane > .cg-files .cg-file').length === 8`, 20000, 'eight files');
  await settle(300);
  const bar = await page.eval<{ panel: number; sum: string; sumWhole: boolean; scope: string; title: string; inBar: boolean }>(`(() => {
    const p = document.getElementById('changesPane'), s = p.querySelector('.cg-sum'), sc = p.querySelector('.cg-scope'), b = p.querySelector('.cg-bar');
    const r = s.getBoundingClientRect(), br = b.getBoundingClientRect(), f = p.querySelector('.cg-refresh').getBoundingClientRect();
    return { panel: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width), sum: s.innerText.replace(/\\s+/g, ' ').trim(),
      sumWhole: s.scrollWidth <= s.clientWidth, scope: sc.textContent, title: sc.title,
      inBar: r.left >= br.left && r.right <= f.left && sc.getBoundingClientRect().right <= r.left };
  })()`);
  assert(bar.panel <= 290, `the default column width: ${bar.panel}`);
  assertEquals(bar.sum, '8 files +14 −11');
  assert(bar.sumWhole, `the counts are cut: ${JSON.stringify(bar)}`);
  assert(bar.inBar, `heading, counts and refresh sit side by side: ${JSON.stringify(bar)}`);
  assertEquals([bar.scope, bar.title], ['Project folder', 'Project folder']);
});

changesTest('Changes, folder chat not working: an edit another chat makes in the folder shows up by itself', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}\\src\\app.ts`, lines(41, 'app'));
  await folderChat(lab, 'IDLEFOLDER');
  await page.waitFor(`document.querySelectorAll('#changesPane > .cg-files .cg-file').length === 1`, 20000, 'one file');
  // the chat is not working; another chat in the same folder writes a file
  write(`${ws}\\from_other_chat.txt`, 'hello\n');
  await page.waitFor(`[...document.querySelectorAll('#changesPane > .cg-files .cg-file')].some((b) => b.dataset.path === 'from_other_chat.txt')`, 25000,
    'the other chat\'s file listed without a chat switch').catch(async (e) => {
      throw new Error(`${e.message}: ${JSON.stringify(await rows(page))}`);
    });
  assertEquals((await rows(page)).sort(), ['from_other_chat.txt', 'src/app.ts']);
  assertEquals(await page.eval<string>(`document.querySelector('#paneTab-changes .pane-badge').textContent`), '2');
});

changesTest('Changes, split view: an open diff follows its file when the file changes', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}\\notes.txt`, 'first line\n');
  const a = await folderChat(lab, 'SPLITA');
  const b = await lab.chat();
  await b.start();
  b.say('Second chat SPLITB');
  b.end();
  await lab.select(b);
  await shown(page, 'SPLITB');
  await lab.select(a);
  await shown(page, 'SPLITA');
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2 && document.querySelectorAll('#splitChanges .sp-grp').length === 2`, 15000, 'two sections');
  await page.eval(`document.getElementById('paneTab-changes').click()`);
  const SEC = '#splitChanges .sp-grp:nth-child(1)';
  await page.waitFor(`!!document.querySelector('${SEC} .cg-file[data-path="notes.txt"]')`, 20000, 'notes.txt listed');
  await page.click(`${SEC} .cg-file[data-path="notes.txt"]`);
  const diff = () => page.eval<string>(`(document.querySelector('${SEC} .cg-diff .cg-lines')?.innerText || '').replace(/\\s+/g, ' ')`);
  await page.waitFor(`/first line/.test(document.querySelector('${SEC} .cg-diff .cg-lines')?.innerText || '')`, 15000, 'the diff');
  assert(!/second line/.test(await diff()), 'not yet');
  write(`${ws}\\notes.txt`, 'first line\nsecond line\nthird line\n');
  await page.waitFor(`/\\+3/.test(document.querySelector('${SEC} .cg-file[data-path="notes.txt"] .cg-add')?.textContent || '')`, 20000, 'the row counts +3');
  await page.waitFor(`/third line/.test(document.querySelector('${SEC} .cg-diff .cg-lines')?.innerText || '')`, 15000, 'the open diff shows the new lines')
    .catch(async (e) => {
      throw new Error(`${e.message}: ${await diff()}`);
    });
  assert(!(await page.eval<boolean>(`[...document.querySelectorAll('${SEC} .cg-msg')].some((m) => /Loading/.test(m.textContent))`)), 'no Loading left');
});

changesTest('Changes, split view: a section counts every changed file, also past the first 300 it lists', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  for (let i = 0; i < 320; i++) write(`${ws}\\big\\f${String(i).padStart(3, '0')}.txt`, 'x\n');
  const a = await folderChat(lab, 'BIGA');
  await page.waitFor(`/^320$/.test(document.querySelector('#paneTab-changes .pane-badge')?.textContent || '')`, 20000, 'badge 320');
  const b = await lab.chat();
  await b.start();
  b.say('Second chat BIGB');
  b.end();
  await lab.select(b);
  await shown(page, 'BIGB');
  await lab.select(a);
  await shown(page, 'BIGA');
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2 && document.querySelectorAll('#splitChanges .sp-grp').length === 2`, 15000, 'two sections');
  await page.eval(`document.getElementById('paneTab-changes').click()`);
  const SEC = '#splitChanges .sp-grp:nth-child(1)';
  await page.waitFor(`document.querySelectorAll('${SEC} .cg-file').length === 300`, 20000, 'the first 300 listed');
  const s = await page.eval<{ head: string; foot: string; badge: string }>(`(() => ({
    head: document.querySelector('${SEC} .sp-head .sp-sub').textContent,
    foot: document.querySelector('${SEC} .sp-foot').innerText.replace(/\\s+/g, ' ').trim(),
    badge: document.querySelector('#paneTab-changes .pane-badge').textContent,
  }))()`);
  assertEquals(s, { head: '320 files', foot: '320 files · +300+ −0', badge: '320' });
});

changesTest('Changes, split view, two folder chats: the folder lists once, rows have the arrow, the idle line says Ready', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}\\notes.txt`, 'first line\n');
  write(`${ws}\\other.txt`, 'x\n');
  const a = await folderChat(lab, 'ONCEA');
  const b = await lab.chat();
  await b.start();
  b.say('Second chat ONCEB');
  b.end();
  await lab.select(b);
  await shown(page, 'ONCEB');
  await lab.select(a);
  await shown(page, 'ONCEA');
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2 && document.querySelectorAll('#splitChanges .sp-grp').length === 2`, 15000, 'two sections');
  await page.eval(`document.getElementById('paneTab-changes').click()`);
  await page.waitFor(`document.querySelectorAll('#splitChanges .cg-file').length === 2`, 20000, 'the folder files, once').catch(async (e) => {
    throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('splitChanges').innerText`)}`);
  });
  await settle(1500);
  const r = await page.eval<{ files: number[]; second: string; arrows: string[]; badge: string }>(`(() => {
    const g = [...document.querySelectorAll('#splitChanges .sp-grp')];
    return { files: g.map((x) => [...x.querySelectorAll('.cg-file')].filter((f) => f.offsetParent).length),
      second: g[1].querySelector('.sp-sub').textContent,
      arrows: [...g[0].querySelectorAll('.cg-file .cg-caret')].map((c) => c.textContent),
      badge: document.querySelector('#paneTab-changes .pane-badge').textContent };
  })()`);
  assertEquals(r.files, [2, 0], JSON.stringify(r));
  assertEquals(r.second, 'Project folder · files listed above');
  assert(r.arrows.length === 2 && r.arrows.every((c) => c === '▸' || c === '▾'), JSON.stringify(r.arrows));
  assertEquals(r.badge, '2');
  await page.eval(`document.getElementById('paneTab-activity').click()`);
  // the section line follows the chat's real state (fix/split-ready-label): an idle chat says Ready, one waiting on you Your turn
  await page.waitFor(`[...document.querySelectorAll('#splitActivity .sp-sub')].some((n) => /^(Ready|Your turn)/.test(n.textContent))`, 15000, 'Ready or Your turn');
  assert(!(await page.eval<boolean>(`/idle/i.test(document.getElementById('splitActivity').innerText)`)), 'no "idle"');
});
