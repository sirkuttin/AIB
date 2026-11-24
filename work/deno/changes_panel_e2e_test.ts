/**
 * The right panel's Changes tab (the project's, slice S2) against a real Git repository (right panel audit, test build 4, 2026-11-16;
 * rewritten 2026-11-18 for the project-level panel).
 *
 * 1. A folder chat with several changed files at the default column width: the counts in the bar ("8 files +14 −11") are whole and
 *    sit side by side with the heading and the refresh icon.
 * 2. A chat that is not working, on its Changes tab: an edit another chat makes in the project folder shows up by itself (the tab
 *    polls while it is on screen).
 * 3. An open diff follows its file when the file changes.
 * 4. The project folder counts every changed file, also past the 300 it lists: the tab badge says 320, the list 300, and a button
 *    lists the rest.
 * 5. Two chats side by side (split view) see ONE list: the project's, listed once.
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), scripted live chats, headless Chrome or
 * Edge, Git.
 *
 * Run (from app): deno test -A ../../work/deno/changes_panel_e2e_test.ts   (ignored without Chrome or Edge)
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
  Deno.mkdirSync(path.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  Deno.writeTextFileSync(path, text);
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

/** The workspace as a repository with one commit (src/app.ts, src/gone.ts). */
function repo(ws: string) {
  git(ws, 'init', '-q', '-b', 'main');
  write(`${ws}/src/app.ts`, lines(40, 'app'));
  write(`${ws}/src/gone.ts`, lines(10, 'gone'));
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
const FILES = '#projectChanges .cg-file';
const rows = (page: Page, box = '#projectChanges') =>
  page.eval<string[]>(`[...document.querySelectorAll('${box} .cg-file')].map((b) => b.dataset.path)`);

changesTest('Changes, folder chat: the counts stay whole at the default width and sit beside the heading and the refresh icon', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}/src/app.ts`, lines(40, 'app').replace('app 5\n', 'app five\nadded\n'));
  Deno.removeSync(`${ws}/src/gone.ts`);
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) write(`${ws}/notes/${n}.md`, lines(2, n));
  await folderChat(lab, 'COUNTS');
  await page.waitFor(`document.querySelectorAll('${FILES}').length === 8`, 20000, 'eight files');
  await settle(300);
  const bar = await page.eval<{ panel: number; sum: string; sumWhole: boolean; scope: string; inBar: boolean; sections: string[] }>(`(() => {
    const p = document.getElementById('changesPane'), s = p.querySelector('.cg-sum'), sc = p.querySelector('.cg-scope'), b = p.querySelector('.cg-bar');
    const r = s.getBoundingClientRect(), br = b.getBoundingClientRect(), f = p.querySelector('.cg-refresh').getBoundingClientRect();
    return { panel: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width), sum: s.innerText.replace(/\\s+/g, ' ').trim(),
      sumWhole: s.scrollWidth <= s.clientWidth, scope: sc.textContent,
      inBar: r.left >= br.left && r.right <= f.left && sc.getBoundingClientRect().right <= r.left,
      sections: [...p.querySelectorAll('#projectChanges > .cg-sec')].map((n) => n.dataset.sec) };
  })()`);
  assert(bar.panel === 320, `the default column width (320 px, owner 2026-11-18): ${bar.panel}`);
  assertEquals(bar.sum, '8 files +14 −11');
  assert(bar.sumWhole, `the counts are cut: ${JSON.stringify(bar)}`);
  assert(bar.inBar, `heading, counts and refresh sit side by side: ${JSON.stringify(bar)}`);
  assertEquals([bar.scope, bar.sections], ['Project', ['main']]);
  // the section head carries the project folder's name and counts, at 320 px nothing wraps or is cut
  const head = await page.eval<{ text: string; whole: boolean }>(`(() => {
    const h = document.querySelector('#projectChanges .cg-sec-head');
    const n = h.querySelector('.cg-sec-name'), s = h.querySelector('.cg-sec-sum');
    return { text: h.innerText.replace(/\\s+/g, ' ').trim(), whole: s.getBoundingClientRect().right <= h.getBoundingClientRect().right && h.scrollWidth <= h.clientWidth && n.getBoundingClientRect().height < 30 };
  })()`);
  assertEquals(head.text, '▾ Project folder 8 files +14 −11');
  assert(head.whole, 'the section head fits the column');
});

changesTest('Changes, folder chat not working: an edit another chat makes in the folder shows up by itself', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}/src/app.ts`, lines(41, 'app'));
  await folderChat(lab, 'IDLEFOLDER');
  await page.waitFor(`document.querySelectorAll('${FILES}').length === 1`, 20000, 'one file');
  // the chat is not working; another chat in the same folder writes a file
  write(`${ws}/from_other_chat.txt`, 'hello\n');
  await page.waitFor(`[...document.querySelectorAll('${FILES}')].some((b) => b.dataset.path === 'from_other_chat.txt')`, 25000,
    'the other chat\'s file listed without a chat switch').catch(async (e) => {
      throw new Error(`${e.message}: ${JSON.stringify(await rows(page))}`);
    });
  assertEquals((await rows(page)).sort(), ['from_other_chat.txt', 'src/app.ts']);
  assertEquals(await page.eval<string>(`document.querySelector('#paneTab-changes .pane-badge').textContent`), '2');
});

changesTest('Changes: an open diff follows its file when the file changes', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}/notes.txt`, 'first line\n');
  await folderChat(lab, 'FOLLOWA');
  const ROW = `${FILES}[data-path="notes.txt"]`;
  await page.waitFor(`!!document.querySelector('${ROW}')`, 20000, 'notes.txt listed');
  const diff = () => page.eval<string>(`(document.querySelector('#projectChanges .cg-diff .cg-lines')?.innerText || '').replace(/\\s+/g, ' ')`);
  if (!(await page.eval<boolean>(`document.querySelector('${ROW}').classList.contains('open')`))) await page.click(ROW);
  await page.waitFor(`/first line/.test(document.querySelector('#projectChanges .cg-diff .cg-lines')?.innerText || '')`, 15000, 'the diff');
  assert(!/second line/.test(await diff()), 'not yet');
  write(`${ws}/notes.txt`, 'first line\nsecond line\nthird line\n');
  await page.waitFor(`/\\+3/.test(document.querySelector('${ROW} .cg-add')?.textContent || '')`, 25000, 'the row counts +3');
  await page.waitFor(`/third line/.test(document.querySelector('#projectChanges .cg-diff .cg-lines')?.innerText || '')`, 15000, 'the open diff shows the new lines')
    .catch(async (e) => {
      throw new Error(`${e.message}: ${await diff()}`);
    });
  assert(!(await page.eval<boolean>(`[...document.querySelectorAll('#projectChanges .cg-msg')].some((m) => /Loading/.test(m.textContent))`)), 'no Loading left');
});

changesTest('Changes: the project folder counts every changed file, also past the first 300 it lists', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  for (let i = 0; i < 320; i++) write(`${ws}/big/f${String(i).padStart(3, '0')}.txt`, 'x\n');
  await folderChat(lab, 'BIGA');
  await page.waitFor(`/^320$/.test(document.querySelector('#paneTab-changes .pane-badge')?.textContent || '')`, 20000, 'badge 320');
  await page.waitFor(`document.querySelectorAll('${FILES}').length === 300`, 20000, 'the first 300 listed');
  const s = await page.eval<{ head: string; more: string; badge: string; sum: string }>(`(() => ({
    head: document.querySelector('#projectChanges .cg-sec-sum').innerText.replace(/\\s+/g, ' ').trim(),
    more: document.querySelector('#projectChanges .cg-more')?.textContent || '',
    badge: document.querySelector('#paneTab-changes .pane-badge').textContent,
    sum: document.querySelector('#changesPane .cg-sum').innerText.replace(/\\s+/g, ' ').trim(),
  }))()`);
  assertEquals(s, { head: '320 files +300+ −0', more: 'Show the last 20 (20 not listed yet)', badge: '320', sum: '320 files +300+ −0' });
  await page.click('#projectChanges .cg-more');
  await page.waitFor(`document.querySelectorAll('${FILES}').length === 320 && !document.querySelector('#projectChanges .cg-more')`, 20000, 'the rest listed');
});

changesTest('Changes, split view: two chats side by side see ONE list, the project\'s, listed once', async (lab) => {
  const page = lab.page,
    ws = lab.fx.workspace;
  repo(ws);
  write(`${ws}/notes.txt`, 'first line\n');
  write(`${ws}/other.txt`, 'x\n');
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
  await page.waitFor(`AgentSplitUI.panes().length === 2`, 15000, 'two panes');
  await page.eval(`document.getElementById('paneTab-changes').click()`);
  await page.waitFor(`document.querySelectorAll('${FILES}').length === 2`, 20000, 'the folder files, once').catch(async (e) => {
    throw new Error(`${e.message}: ${await page.eval<string>(`document.getElementById('changesPane').innerText`)}`);
  });
  await settle(1500);
  const r = await page.eval<{ sections: string[]; files: number; arrows: string[]; badge: string }>(`(() => ({
    sections: [...document.querySelectorAll('#projectChanges > .cg-sec')].map((n) => n.dataset.sec),
    files: [...document.querySelectorAll('${FILES}')].filter((f) => f.offsetParent).length,
    arrows: [...document.querySelectorAll('${FILES} .cg-caret')].map((c) => c.textContent),
    badge: document.querySelector('#paneTab-changes .pane-badge').textContent }))()`);
  assertEquals([r.sections, r.files, r.badge], [['main'], 2, '2'], JSON.stringify(r));
  assert(r.arrows.length === 2 && r.arrows.every((c) => c === '▸' || c === '▾'), JSON.stringify(r.arrows));
  await page.eval(`document.getElementById('paneTab-activity').click()`);
  // Activity lists only the project's working chats (owner 2026-11-18): both chats finished, so no section, the note says so
  await page.waitFor(`!!document.querySelector('#projectActivity > .sp-empty') && !document.querySelector('#projectActivity .sp-grp')`, 15000, 'no working chat');
  assert(!(await page.eval<boolean>(`/idle/i.test(document.getElementById('projectActivity').innerText)`)), 'no "idle"');
});
