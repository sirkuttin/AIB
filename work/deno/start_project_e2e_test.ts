/**
 * Real Studio server + headless Chrome/Edge (its own temp profile, so localStorage starts empty, as in a new build folder): AIB opens
 * on the project you had, with last session's chat, when that chat runs in an AIB worktree made from a Claude worktree.
 *
 * beta.8-test6 (owner's data, trimmed and anonymised): the saved project was the main checkout; its only open chat ran in an AIB
 * worktree whose project is a Claude worktree of that checkout (<main>/.claude/worktrees/<name>). The server files the chat under
 * the Claude worktree; only the page's folder-kinds request (worktreeOf) files it under the main checkout. At the first list the
 * main checkout therefore had no chat, the sidebar moved to the first project in the dropdown (a scratch folder) and that
 * project's chat opened. The same chat was also still in the tabs of the Claude worktree's key from an earlier start.
 *
 * Throwaway data folder, temp HOME/APPDATA/LOCALAPPDATA, free ports, no agent runs (--no-auto-reconnect). Gives up after 15 minutes.
 */
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { assert, assertEquals } from './_assert.ts';
import { Fixture, SEP, TEST_OPTIONS, until } from './_host_fixture.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { git, HAVE_GIT } from './_git_repo.ts';

const key = (path: string) => 'w:' + path.replaceAll('\\', '/').toLowerCase();

function transcript(
  claude: string,
  id: string,
  cwd: string,
  minutesAgo: number,
  text: string,
): void {
  const stamp = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const rows = [
    {
      type: 'user',
      sessionId: id,
      cwd,
      timestamp: stamp,
      message: { role: 'user', content: text },
    },
    {
      type: 'assistant',
      sessionId: id,
      cwd,
      timestamp: stamp,
      message: {
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: 'Done.' }],
      },
    },
  ];
  const dir = `${claude}${SEP}enc-${id}`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    `${dir}${SEP}${id}.jsonl`,
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

Deno.test({
  name: 'start: the saved project wins and its chat reopens, when that chat runs in a worktree of a Claude worktree (beta.8-test6)',
  ignore: !browserPath || !HAVE_GIT,
  ...TEST_OPTIONS,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(
        () => reject(new Error('gave up after 15 minutes')),
        15 * 60_000,
      );
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
  // The main checkout and a Claude worktree of it; an AIB worktree folder made from that Claude worktree; two other projects.
  const main = `${r}${SEP}main`,
    claudeWt = `${main}${SEP}.claude${SEP}worktrees${SEP}wt-one`;
  const aibWt = `${r}${SEP}aib-worktrees${SEP}0a1b2c${SEP}chat-0a1b2c3d`;
  const art = `${r}${SEP}scratchpad${SEP}artifact-test`,
    zeta = `${r}${SEP}zeta`;
  for (const d of [main, aibWt, art, zeta]) {
    Deno.mkdirSync(d, { recursive: true });
  }
  git(main, 'init', '-q', '-b', 'main');
  Deno.writeTextFileSync(`${main}${SEP}readme.txt`, 'x\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'wt-one', claudeWt);

  const claude = `${r}${SEP}claude`;
  transcript(claude, 's-main', aibWt, 1, 'Work on main');
  transcript(claude, 's-art', art, 2, 'Artifact test');
  transcript(claude, 's-zeta', zeta, 3, 'Work on zeta');
  // The user added these three projects (AIB lists saved agent chats of added projects only).
  const added: Record<string, { path: string; at: number }> = {};
  for (const path of [main, art, zeta]) added[projectKey(path)] = { path, at: 1 };
  Deno.writeTextFileSync(`${fx.state}${SEP}studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, added }));
  // studio-worktrees.json: the AIB worktree's project is the Claude worktree (what the server files the chat under).
  Deno.writeTextFileSync(
    `${fx.state}${SEP}studio-worktrees.json`,
    JSON.stringify({
      version: 1,
      worktrees: {
        '0a1b2c3d00000000000000000000000a': {
          path: aibWt,
          project: claudeWt,
          branch: 'studio/chat-0a1b2c3d',
          base: 'wt-one',
          status: 'ready',
          created: 1,
          session: 'claude:s-main',
        },
      },
      removed: {},
    }),
  );
  const MAIN = key(main),
    CLAUDE_WT = key(claudeWt),
    ART = key(art),
    ZETA = key(zeta);
  // studio-view.json as the owner had it: Main open, its chat also under the Claude worktree's key (a stale duplicate).
  const ws = {
    v: 1,
    active: MAIN,
    tabs: {
      [MAIN]: ['claude:s-main'],
      [ZETA]: ['claude:s-zeta'],
      [CLAUDE_WT]: ['claude:s-main'],
      [ART]: ['claude:s-art'],
    },
    last: {
      [ZETA]: 'claude:s-zeta',
      [CLAUDE_WT]: 'claude:s-main',
      [ART]: 'claude:s-art',
      [MAIN]: 'claude:s-main',
    },
    recent: MAIN,
  };
  Deno.writeTextFileSync(
    `${fx.state}${SEP}studio-view.json`,
    JSON.stringify({
      version: 1,
      savedAt: 1,
      prefs: { 'studio-workspace-v1': JSON.stringify(ws) },
    }),
  );
  const home = `${r}${SEP}home`;
  for (const d of ['appdata', 'localappdata', 'home']) {
    Deno.mkdirSync(`${r}${SEP}${d}`, { recursive: true });
  }
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
    const page = await browser.open(
      `http://127.0.0.1:${web.port}/`,
      1900,
      1000,
    );
    await page.waitFor(
      `!!(window.AgentWorkspaceUI && AgentWorkspaceUI._items().length >= 3)`,
      30_000,
      'the three chats listed',
    );
    await page.waitFor(
      `document.getElementById('title').textContent === 'Work on main'`,
      15_000,
      "last session's chat open",
    );
    await new Promise((res) => setTimeout(res, 3000)); // a few list polls: nothing moves the sidebar afterwards either
    const state = await page.eval<
      { active: string; tabs: Record<string, string[]> }
    >(`AgentWorkspaceUI._state()`);
    assertEquals(
      state.active,
      MAIN,
      'the saved project (it used to move to the first one in the dropdown, artifact-test)',
    );
    assertEquals(
      await page.eval(`document.getElementById('title').textContent`),
      'Work on main',
    );
    assertEquals(
      await page.eval(
        `AgentWorkspaceUI._items().find((i) => i.key === 'claude:s-main').projectKey`,
      ),
      MAIN,
      'the chat is filed under the main checkout',
    );
    assertEquals(
      state.tabs[CLAUDE_WT],
      undefined,
      "the chat's stale tab under the Claude worktree's key is gone",
    );
    assertEquals(page.errors, [], 'no page errors');
    // and the data folder keeps it that way
    const saved = await until(
      () => {
        const file = JSON.parse(
          fx.read(`${fx.state}${SEP}studio-view.json`) || '{}',
        );
        const v = JSON.parse(file.prefs?.['studio-workspace-v1'] ?? '{}');
        return v.tabs && !v.tabs[CLAUDE_WT] ? v : null;
      },
      'the cleaned state saved',
      10,
    );
    assertEquals(saved.active, MAIN);
    assert(saved.tabs[MAIN]?.includes('claude:s-main'), 'Main keeps its tab');
    assertEquals(
      saved.tabs[ART],
      ['claude:s-art'],
      "other projects' tabs stay",
    );
  } finally {
    await web.kill();
  }
}

/** Before the page sees a script: the folder-kinds answer comes 1.5 s late (a busy machine), and every chat opened is counted. */
const SLOW_KINDS = `(() => {
  const f = window.fetch;
  window.fetch = function (u) {
    const args = arguments;
    if (String(u).includes('folders/kinds')) return new Promise((r) => setTimeout(r, 1500)).then(() => f.apply(window, args));
    return f.apply(window, args);
  };
  window.__opened = [];
  let ws;
  Object.defineProperty(window, 'AgentWorkspaceUI', {
    configurable: true,
    get: () => ws,
    set(v) {
      const note = v.noteOpened;
      v.noteOpened = (c) => (window.__opened.push(c && c.id), note(c));
      ws = v;
    },
  });
})()`;

Deno.test({
  name:
    "start: a chat opened and a project picked while the page waits for folder kinds stay; last session's chat is not reopened over them",
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
      await Promise.race([deadline, runEarly(fx, (b) => (browser = b))]);
    } finally {
      clearTimeout(giveUp);
      await browser?.close();
    }
  },
});

async function runEarly(fx: Fixture, keep: (b: Browser) => void): Promise<void> {
  const r = fx.root, claude = `${r}${SEP}claude`;
  const dirs = ['Alpha', 'Beta', 'Delta'].map((n) => `${r}${SEP}projects${SEP}${n}`);
  dirs.forEach((d, i) => {
    Deno.mkdirSync(d, { recursive: true });
    transcript(claude, `s-${i}`, d, i + 1, `Work on ${['Alpha', 'Beta', 'Delta'][i]}`);
  });
  const [ALPHA, BETA, DELTA] = dirs.map(key);
  // Last session: Alpha's chat was open (it would be reopened at start).
  const ws = { v: 1, active: ALPHA, tabs: { [ALPHA]: ['claude:s-0'] }, last: { [ALPHA]: 'claude:s-0' }, recent: ALPHA };
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
    const page = await browser.open('about:blank', 1900, 1000);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_KINDS });
    await page.goto(`http://127.0.0.1:${web.port}/`);
    await page.waitFor(`!!(window.AgentWorkspaceUI && AgentWorkspaceUI._items().length >= 3)`, 30_000, 'the three chats listed');
    // While the folder kinds are on their way: open Beta's chat, then pick Delta (no tabs: Beta's chat stays in the middle).
    await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(BETA)}), 1`);
    await page.waitFor(`!!document.querySelector('#connections button[data-key="claude:s-1"]')`, 10_000, "Beta's chat listed");
    await page.eval(`document.querySelector('#connections button[data-key="claude:s-1"]').click(), 1`);
    await page.waitFor(`document.getElementById('title').textContent === 'Work on Beta'`, 10_000, "Beta's chat open");
    await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(DELTA)}), 1`);
    assertEquals(await page.eval(`window.__opened.slice()`), ['s-1'], 'opened before the kinds answered (the test is meaningful)');
    await new Promise((res) => setTimeout(res, 3000)); // the kinds answer, and a list poll
    assertEquals(await page.eval(`window.__opened.slice()`), ['s-1'], "last session's chat (Alpha's) was not reopened over Beta's");
    assertEquals(await page.eval(`document.getElementById('title').textContent`), 'Work on Beta');
    assertEquals(await page.eval(`AgentWorkspaceUI._state().active`), DELTA, 'the project you picked');
    const saved = await until(
      () => {
        const file = JSON.parse(fx.read(`${fx.state}${SEP}studio-view.json`) || '{}');
        const v = JSON.parse(file.prefs?.['studio-workspace-v1'] ?? '{}');
        return v.active === DELTA ? v : null;
      },
      'the pick saved',
      10,
    );
    assertEquals(saved.active, DELTA);
    assertEquals(page.errors, [], 'no page errors');
  } finally {
    await web.kill();
  }
}
