/**
 * Local-only folders in Files (owner decisions 1a, 3, 4a), end to end: a real Studio server + headless Chrome/Edge (own temp profile
 * and data folder, free ports, no agent runs) on a temp git repo whose main folder has a local-only private/ (AIB's block in
 * .git/info/exclude) and a chat working in its own copy (a git worktree with no private/ on disk).
 *   E2E-1  the chat copy's Files shows the main folder's private/ in normal colour with the blue dot and the "local only" pill, and
 *          opens it and private/designs without "Show ignored"; nothing is put in the copy.
 *   E2E-5  right-click a file -> "Git exclude": the AIB block gets the line (the user's lines and CRLF kept), the file moves from the
 *          copy into the main folder (owner Q3) and the row turns local; the foot offers Undo, which removes only that line. A tracked
 *          file shows the item greyed with its reason.
 * AIB_DOCPAGE_SHOTS=<folder> keeps a screenshot per step, light and dark (AIB teal).
 */
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { assert, assertEquals } from './_assert.ts';
import { git, HAVE_GIT } from './_git_repo.ts';
import { Fixture, SEP, TEST_OPTIONS } from './_host_fixture.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';

const key = (path: string) => 'w:' + path.replaceAll('\\', '/').toLowerCase();

function transcript(claude: string, id: string, cwd: string, text: string): void {
  const stamp = new Date(Date.now() - 60_000).toISOString();
  const rows = [
    { type: 'user', sessionId: id, cwd, timestamp: stamp, message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: id, cwd, timestamp: stamp, message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  const dir = `${claude}${SEP}enc-${id}`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(`${dir}${SEP}${id}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

Deno.test({
  name: 'local only in Files: a chat copy shows the main folder private/ (pill, dot, opens without Show ignored); Git exclude with Undo',
  ignore: !browserPath || !HAVE_GIT,
  ...TEST_OPTIONS,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 10 minutes')), 10 * 60_000);
    });
    await using fx = new Fixture();
    let browser: Browser | undefined;
    try {
      await Promise.race([deadline, run(fx, (b) => (browser = b))]);
    } finally {
      clearTimeout(giveUp);
      await browser?.close();
    }
  },
});

const rowsOf = (page: Page) =>
  page.eval<{ path: string; cls: string; title: string; pill: string; dot: boolean }[]>(
    `Array.from(document.querySelectorAll('.fx-row[data-path]')).map((n) => ({ path: n.dataset.path, cls: n.className, title: n.title,
      pill: (n.querySelector('.fx-local') || {}).textContent || '', dot: !!n.querySelector('.fx-localdot') }))`,
  );
const rightClick = (page: Page, path: string) =>
  page.eval(`(() => { const n = Array.from(document.querySelectorAll('.fx-row[data-path]')).find((x) => x.dataset.path === ${JSON.stringify(path)});
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 14 })); })()`);
const menuItem = (page: Page) =>
  page.eval<{ disabled: boolean; text: string; sub: string } | null>(`(() => { const b = document.querySelector('.fx-menu .fx-menu-excl');
    return b ? { disabled: b.disabled, text: b.querySelector('.fx-menu-t').textContent, sub: b.querySelector('.sub').textContent } : null; })()`);

async function run(fx: Fixture, keep: (b: Browser) => void): Promise<void> {
  const r = fx.root;
  const alpha = `${r}${SEP}Alpha`, copy = `${r}${SEP}copies${SEP}chat-5e1f`;
  Deno.mkdirSync(alpha, { recursive: true });
  git(alpha, 'init', '-q');
  Deno.writeTextFileSync(`${alpha}${SEP}README.md`, '# alpha\n');
  Deno.writeTextFileSync(`${alpha}${SEP}.gitignore`, 'build/\n');
  Deno.mkdirSync(`${alpha}${SEP}src`);
  Deno.writeTextFileSync(`${alpha}${SEP}src${SEP}app.ts`, 'export {};\n');
  git(alpha, 'add', '-A');
  git(alpha, 'commit', '-q', '-m', 'base');
  // the main folder's local-only private/ (never committed), and the user's own exclude lines in CRLF
  const exclude = `${alpha}${SEP}.git${SEP}info${SEP}exclude`;
  Deno.writeTextFileSync(exclude, '# my own lines\r\n/.test-logs/\r\n# AIB: local only (shown in every chat; never committed)\r\n/private\r\n# AIB: end\r\n');
  Deno.mkdirSync(`${alpha}${SEP}private${SEP}designs`, { recursive: true });
  Deno.writeTextFileSync(`${alpha}${SEP}private${SEP}TASKS.md`, '# Tasks\n- ship it\n');
  Deno.writeTextFileSync(`${alpha}${SEP}private${SEP}designs${SEP}look.html`, '<h1>look</h1>\n');
  // the chat's own copy: a worktree made from the commit, so it has no private/
  Deno.mkdirSync(`${r}${SEP}copies`);
  git(alpha, 'worktree', 'add', '-q', '-b', 'studio/chat-5e1f', copy);
  Deno.writeTextFileSync(`${copy}${SEP}scratch.md`, 'only in this copy\n');
  Deno.writeTextFileSync(
    `${fx.state}${SEP}studio-worktrees.json`,
    JSON.stringify({ version: 1, worktrees: { k1: { path: copy, project: alpha, status: 'ready', branch: 'studio/chat-5e1f', session: 's-wt' } } }),
  );
  transcript(`${r}${SEP}claude`, 's-wt', copy, 'Plan the release');
  const added: Record<string, { path: string; at: number }> = { [projectKey(alpha)]: { path: alpha, at: 1 } };
  Deno.writeTextFileSync(`${fx.state}${SEP}studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, added }));
  const ALPHA = key(alpha);
  const ws = { v: 1, active: ALPHA, tabs: { [ALPHA]: ['claude:s-wt'] }, last: { [ALPHA]: 'claude:s-wt' }, recent: ALPHA };
  Deno.writeTextFileSync(
    `${fx.state}${SEP}studio-view.json`,
    JSON.stringify({ version: 1, savedAt: 1, prefs: { 'studio-workspace-v1': JSON.stringify(ws), 'aib-theme': 'teal-light' } }),
  );
  const home = `${r}${SEP}home`;
  for (const d of ['appdata', 'localappdata', 'home']) Deno.mkdirSync(`${r}${SEP}${d}`, { recursive: true });
  const web = await fx.startWeb(['--in-process', '--no-auto-reconnect'], {
    env: {
      USERPROFILE: home,
      HOME: home,
      APPDATA: `${r}${SEP}appdata`,
      LOCALAPPDATA: `${r}${SEP}localappdata`,
      CODEX_HOME: `${home}${SEP}.codex`,
      AIB_UPDATE_API_BASE: 'http://127.0.0.1:9',
    },
  });
  try {
    const browser = await Browser.launch();
    keep(browser);
    const page = await browser.open(`http://127.0.0.1:${web.port}/`, 1600, 900);
    await page.waitFor(`document.getElementById('title').textContent === 'Plan the release'`, 30_000, 'the worktree chat open');
    await page.eval(`AibThemes.choose('teal-light')`);
    await page.eval(`AgentFilesUI.setMode('files')`);
    await page.waitFor(`!!document.querySelector('.fx-row[data-path="private"]')`, 20_000, 'private listed in the chat copy');
    const scope = await page.eval<{ root: string; branch: string }>(`AgentFilesUI.currentScope()`);
    assertEquals([scope.root, scope.branch], ['chat', 'studio/chat-5e1f'], "Files shows the chat's own copy");

    // E2E-1: the main folder's private/ in the copy's scope; nothing on disk in the copy
    let rows = await rowsOf(page);
    const priv = rows.find((x) => x.path === 'private')!;
    assert(priv.cls.includes('local') && !priv.cls.includes('ignored'), priv.cls);
    assertEquals([priv.pill, priv.dot], ['local only', true]);
    assert(priv.title.includes('The same folder in every chat: ' + alpha + SEP + 'private'), priv.title);
    assert(!(await exists(`${copy}${SEP}private`)), 'nothing is put in the copy');
    await page.eval(`document.querySelector('.fx-row[data-path="private"]').click()`);
    await page.waitFor(`!!document.querySelector('.fx-row[data-path="private/designs"]')`, 10_000, 'private opened without Show ignored');
    await page.eval(`document.querySelector('.fx-row[data-path="private/designs"]').click()`);
    await page.waitFor(`!!document.querySelector('.fx-row[data-path="private/designs/look.html"]')`, 10_000, 'private/designs opened');
    rows = await rowsOf(page);
    assert(rows.find((x) => x.path === 'private/TASKS.md')!.cls.includes('local'));
    assertEquals(await page.eval(`(document.querySelector('.fx-foot-link') || {}).textContent`), 'Show ignored', 'Show ignored untouched');
    await page.shot('1-files-worktree-private-light');

    // a tracked file: the item is there, greyed, with the reason
    await rightClick(page, 'README.md');
    assertEquals(await menuItem(page), { disabled: true, text: 'Git exclude', sub: "Git tracks this, so it can't be excluded" });
    await page.key('Escape');
    // E2E-5: a file only this copy has -> Git exclude moves it into the main folder and excludes it
    await rightClick(page, 'scratch.md');
    assertEquals(await menuItem(page), { disabled: false, text: 'Git exclude', sub: 'Moves it to the main folder, never committed' });
    await page.shot('2-files-row-menu-light');
    await page.eval(`document.querySelector('.fx-menu .fx-menu-excl').click()`);
    await page.waitFor(`!document.querySelector('.fx-foot-undo').hidden`, 10_000, 'the Undo in the foot');
    assertEquals(await page.eval(`document.querySelector('.fx-foot-t').textContent`), 'Excluded scratch.md');
    assert((await page.eval<string>(`document.querySelector('.fx-foot-t').title`)).includes('Moved from this copy into the main folder'));
    await page.waitFor(
      `(() => { const n = document.querySelector('.fx-row[data-path="scratch.md"]'); return !!n && n.classList.contains('local'); })()`,
      10_000,
      'the row turns local',
    );
    const text = Deno.readTextFileSync(exclude);
    assertEquals(text, '# my own lines\r\n/.test-logs/\r\n# AIB: local only (shown in every chat; never committed)\r\n/private\r\n/scratch.md\r\n# AIB: end\r\n');
    assertEquals(Deno.readTextFileSync(`${alpha}${SEP}scratch.md`), 'only in this copy\n');
    assert(!(await exists(`${copy}${SEP}scratch.md`)), 'the file left the copy');
    await page.shot('3-files-undo-foot-light');

    // the same three looks in dark
    await page.eval(`AibThemes.choose('teal-dark')`);
    await page.shot('4-files-undo-foot-dark');
    await page.waitFor(`!!document.querySelector('.fx-row[data-path="src"]')`, 10_000, 'the tree listed again');
    await rightClick(page, 'src');
    await page.shot('5-files-row-menu-dark');
    await page.key('Escape');

    // Undo removes only that line
    await page.eval(`document.querySelector('.fx-foot-undo').click()`);
    await page.waitFor(`document.querySelector('.fx-foot-undo').hidden`, 10_000, 'Undo done');
    assertEquals(Deno.readTextFileSync(exclude), '# my own lines\r\n/.test-logs/\r\n# AIB: local only (shown in every chat; never committed)\r\n/private\r\n# AIB: end\r\n');
    await page.shot('6-files-worktree-private-dark');
    assertEquals(page.errors, [], 'no page errors');
  } finally {
    await web.kill();
    try {
      git(alpha, 'worktree', 'remove', '--force', copy);
    } catch { /* the temp folder goes anyway */ }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
