/**
 * Real Studio server + headless Chrome/Edge (own temp profile and data folder, free ports, no agent runs). The owner added a new
 * project with "New project" and started no chat in it, then switched to it from a project whose chat was open:
 *   1. the main pane kept showing the OTHER project's chat (its title, branch chip, changes and transcript) next to the strip's
 *      "No open chats in <project>". A project with no open chat shows the new-chat view in that project, never another's chat.
 *   2. Files said "No chat open / Open a chat in this project to see its files." With no chat, Files shows the project's own
 *      folder (read only, ignored rows dimmed, aib-docs first), and the Folder menu offers it.
 * The server half: the project route shows only a folder the user added.
 */
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { assert, assertEquals } from './_assert.ts';
import { Fixture, SEP, TEST_OPTIONS } from './_host_fixture.ts';
import { Browser, browserPath } from './_doc_browser.ts';

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
  name: "a project with no chat: the main pane shows the new-chat view, not the other project's chat; Files browses the project folder",
  ignore: !browserPath,
  ...TEST_OPTIONS,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 15 minutes')), 15 * 60_000);
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

async function run(fx: Fixture, keep: (b: Browser) => void): Promise<void> {
  const r = fx.root;
  const alpha = `${r}${SEP}Alpha`, empty = `${r}${SEP}Empty`, outsider = `${r}${SEP}Outsider`;
  for (const d of [alpha, empty, outsider]) Deno.mkdirSync(d, { recursive: true });
  // The empty project's own folder: ordinary files, an ignored folder (node_modules is always ignored), aib-docs.
  Deno.mkdirSync(`${empty}${SEP}src`);
  Deno.mkdirSync(`${empty}${SEP}node_modules`);
  Deno.mkdirSync(`${empty}${SEP}aib-docs`);
  Deno.writeTextFileSync(`${empty}${SEP}README.md`, '# empty\n');
  Deno.writeTextFileSync(`${empty}${SEP}src${SEP}a.txt`, 'hello\n');
  Deno.writeTextFileSync(`${empty}${SEP}node_modules${SEP}x.js`, 'x');
  Deno.writeTextFileSync(`${outsider}${SEP}secret.txt`, 'no');
  transcript(`${r}${SEP}claude`, 's-alpha', alpha, 'Server rewrite spec');
  const added: Record<string, { path: string; at: number }> = {};
  for (const path of [alpha, empty]) added[projectKey(path)] = { path, at: 1 };
  Deno.writeTextFileSync(`${fx.state}${SEP}studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, added }));
  const ALPHA = key(alpha), EMPTY = key(empty);
  const ws = { v: 1, active: ALPHA, tabs: { [ALPHA]: ['claude:s-alpha'] }, last: { [ALPHA]: 'claude:s-alpha' }, recent: ALPHA };
  Deno.writeTextFileSync(
    `${fx.state}${SEP}studio-view.json`,
    JSON.stringify({ version: 1, savedAt: 1, prefs: { 'studio-workspace-v1': JSON.stringify(ws) } }),
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
    const page = await browser.open(`http://127.0.0.1:${web.port}/`, 1900, 1000);
    await page.waitFor(`document.getElementById('title').textContent === 'Server rewrite spec'`, 30_000, "Alpha's chat open");

    // Server: the project route shows an added folder only, and nothing outside it.
    const list = async (p: string, extra = '') => {
      const [status, body] = await web.get(`/api/live/files/list?root=project&project=${encodeURIComponent(p)}${extra}`);
      return { status, entries: ((body as { entries?: { name: string }[] }).entries ?? []).map((e) => e.name).sort() };
    };
    const ok = await list(empty);
    assertEquals(ok.status, 200);
    assertEquals(ok.entries, ['README.md', 'aib-docs', 'node_modules', 'src']);
    assertEquals((await list(outsider)).status, 404, 'a folder that is not an added project is refused');
    assertEquals((await list(`${empty}${SEP}src`)).status, 404, 'a sub-folder of a project is not a project');
    assertEquals((await list(empty, '&dir=..')).status, 400, 'paths stay inside the project folder');

    // Switch to the project with no chat.
    await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(EMPTY)})`);
    await page.waitFor(`document.getElementById('title').textContent === 'New chat'`, 10_000, 'the main pane left the other project chat');
    assertEquals(await page.eval(`AgentWorkspaceUI._state().active`), EMPTY);
    assert(
      !(await page.eval<string>(`document.getElementById('messages').textContent`)).includes('Done.'),
      "the other project's transcript is gone from the main pane",
    );
    // Files: the project's own folder.
    await page.eval(`AgentFilesUI.setMode('files')`);
    await page.waitFor(`document.querySelectorAll('.fx-row[data-path]').length >= 4`, 15_000, 'the project folder listed');
    const rows = await page.eval<{ path: string; ignored: boolean }[]>(
      `Array.from(document.querySelectorAll('.fx-row[data-path]')).map((n) => ({ path: n.dataset.path, ignored: n.classList.contains('ignored') }))`,
    );
    assertEquals(rows[0].path, 'aib-docs', 'aib-docs first');
    assertEquals(rows.map((x) => x.path).sort(), ['README.md', 'aib-docs', 'node_modules', 'src']);
    assert(rows.find((x) => x.path === 'node_modules')!.ignored, 'ignored rows are dimmed');
    const scopeText = await page.eval<string>(`document.querySelector('.fx-scope').textContent`);
    assert(scopeText.includes('Empty') && !scopeText.includes('No chat open'), scopeText);
    assertEquals(await page.eval<number>(`document.querySelectorAll('.fx-empty').length`), 0, 'no "Open a chat" notice');
    // The Folder menu offers the project folder.
    await page.eval(`document.querySelector('.fx-scope').click()`);
    const menu = await page.eval<string>(`(document.querySelector('.fx-menu') || {}).textContent || ''`);
    assert(menu.includes('Project folder'), menu);
    assertEquals(page.errors, [], 'no page errors');
  } finally {
    await web.kill();
  }
}
