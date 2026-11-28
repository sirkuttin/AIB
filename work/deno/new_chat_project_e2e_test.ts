/**
 * Owner bug 2026-11-28: a chat typed in the window of a NEW project (just added, the server slow) started in another project.
 * The window knew its project by key only; the project list had no entry for it yet, so the new-chat folder fell back to the folder
 * box, which another window had filled (localStorage is shared by every window). Real AIB server + headless browser, two windows:
 *   A. the new project's window (a project window pinned to it, its project list answer 5 s late, the folder box holding the OTHER
 *      project's folder): the send waits for the folder, then the chat starts in the new project and is listed there only.
 *   B. a window whose project the server does not know: the send is refused with a clear message, the text is kept, no chat starts.
 *   C. the server refuses a connect whose folder is not the project the request names (also for a WSL folder).
 * Throwaway data folder, temp HOME, free ports, the fake agent. Gives up after 15 minutes.
 */
import { projectKey } from '../../app/server/desktop/project_delete.ts';
import { assert, assertEquals } from './_assert.ts';
import { Fixture, SEP, TEST_OPTIONS, until } from './_host_fixture.ts';
import { Browser, browserPath } from './_doc_browser.ts';

Deno.test({
  name: "a chat typed in a new project's window starts in that project, never in the folder another window left (slow server, unknown project, server guard)",
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

/** Before the page sees a script: the project list answer comes late (an overloaded server); the folder box holds the other project's folder. */
const slowPrefs = (delayMs: number, staleCwd: string) => `(() => {
  const f = window.fetch;
  window.fetch = function (u) {
    const args = arguments;
    if (String(u).includes('/api/live/project-prefs') && !(args[1] && args[1].method === 'POST')) {
      return new Promise((r) => setTimeout(r, ${delayMs})).then(() => f.apply(window, args));
    }
    return f.apply(window, args);
  };
  try { localStorage.setItem('studio-cwd', ${JSON.stringify(staleCwd)}); } catch (e) {}
})()`;

async function run(fx: Fixture, keep: (b: Browser) => void): Promise<void> {
  const r = fx.root;
  const alpha = `${r}${SEP}Alpha`, act = `${r}${SEP}Act`;
  for (const d of [alpha, act]) Deno.mkdirSync(d, { recursive: true });
  const ALPHA = projectKey(alpha), ACT = projectKey(act);
  const added: Record<string, { path: string; at: number }> = {};
  for (const path of [alpha, act]) added[projectKey(path)] = { path, at: 1 };
  Deno.writeTextFileSync(`${fx.state}${SEP}studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, added }));
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
  const listing = async () => ((await web.listing()).connections as { cwd: string }[]).map((c) => c.cwd).join('|');
  try {
    // C. the server guard (needs no browser)
    for (const cwd of [alpha, `wsl://Ubuntu/home/me/other`]) {
      const [status, body] = await web.post('connect', { provider: 'claude', cwd, resume: '', project: ACT });
      assertEquals(status, 400, `a connect naming ${ACT} for ${cwd} is refused`);
      assert(String(body.error).includes('another project'), String(body.error));
    }
    assert(!(await listing()).includes('Alpha'), 'the refused connect started nothing');

    const browser = await Browser.launch();
    keep(browser);
    // A. the new project's window, project list 5 s late, the folder box stale
    const w2 = await browser.open('about:blank', 1400, 900);
    await w2.send('Page.addScriptToEvaluateOnNewDocument', { source: slowPrefs(5000, alpha) });
    await w2.goto(`http://127.0.0.1:${web.port}/?w=w2&kind=project&project=${encodeURIComponent(ACT)}`);
    await w2.waitFor(`document.body.classList.contains('new-chat') && !!document.getElementById('prompt')`, 30_000, 'the new-chat view');
    assertEquals(await w2.eval(`AgentWorkspaceUI.activeProject()`), null, 'the project list has no entry for the window yet (the test is meaningful)');
    await w2.eval(`(() => { const p = document.getElementById('prompt'); p.value = 'check the files I just added'; p.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await w2.click('#send');
    await until(async () => (await listing()).includes('Act'), 'the chat started', 30);
    const live = await listing();
    assert(!live.includes('Alpha'), 'nothing started in Alpha: ' + live);
    await w2.waitFor(`document.getElementById('title').textContent !== 'New chat'`, 20_000, 'the chat opens in the window');
    const shown = await w2.eval<string>(`JSON.stringify(AgentWorkspaceUI._items().map((i) => [i.projectKey, i.title]))`);
    assert(shown.includes(JSON.stringify(ACT)) && !shown.includes(JSON.stringify(ALPHA)), 'the chat is listed in Act only: ' + shown);

    // B. a project the server does not know: refused, text kept, nothing started
    const ghost = `${r}${SEP}Ghost`;
    const before = await listing();
    const w3 = await browser.open('about:blank', 1400, 900);
    await w3.send('Page.addScriptToEvaluateOnNewDocument', { source: slowPrefs(0, alpha) + ';window.__aibTestFolderWaitMs = 1500;' });
    await w3.goto(`http://127.0.0.1:${web.port}/?w=w3&kind=project&project=${encodeURIComponent(projectKey(ghost))}`);
    await w3.waitFor(`document.body.classList.contains('new-chat') && !!document.getElementById('prompt')`, 30_000, 'the new-chat view');
    await w3.eval(`(() => { const p = document.getElementById('prompt'); p.value = 'hello ghost'; p.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await w3.click('#send');
    await w3.waitFor(`/not loaded yet/.test(document.body.innerText)`, 15_000, 'the refusal message');
    assertEquals(await w3.eval(`document.getElementById('prompt').value`), 'hello ghost', 'the text is kept');
    assertEquals(await listing(), before, 'nothing started for the unknown project');
  } finally {
    await web.kill();
  }
}
