/**
 * Owner steps 2026-11-28, scripted with the real page flows: a window shows project braveTV (a git repo) with a chat; from it the
 * owner starts a NEW project "Act" (the real New project dialog: the server makes the folder, git init); Act is then opened in a NEW
 * window although it is the first window's current project (the project's "Open in new window" menu item, K3 op 'open'); AIB is
 * restarted as an update does (the web server dies, the agent host and its chats stay, the windows come back on their saved URLs);
 * a new chat in the Act window starts in Act's folder.
 *
 *   1. window m (?w=m) shows braveTV and its chat; the new project Act is made through the dialog, the window switches to Act with
 *      an empty new-chat view (no braveTV chat under Act's header).
 *   2. Act is opened in a new window (w2, a project window pinned to Act). Both windows show Act; neither window shows a chat of
 *      braveTV under Act's header; w2's tabs hold no braveTV chat, w2's list never offers braveTV's chat as its own.
 *   3. restart: the web server is killed and started again on the same port with the same data folder; both windows reload on their
 *      URLs (the desktop app's saved window list: here the fake K4 list) and come back each on its project, with its own tabs.
 *   4. in w2 a new chat's first message starts a chat whose folder is Act's, listed under Act only, never under braveTV.
 *   5. WSL: the same steps with a WSL project (fake agent host, wsl:// folder) as the second project.
 *
 * Real AIB server (own data folder, free ports), headless Chrome/Edge, the fake agent, a fake desktop-window list (K4) behind the
 * real route (web/windows_route.ts). Nothing is shown on screen. Gives up after 15 minutes.
 */
import { projectKey } from '../../app/server/desktop/project_delete.ts';
import { WindowsRoute } from '../../app/server/web/windows_route.ts';
import { assert, assertEquals } from './_assert.ts';
import { Fixture, SEP, TEST_OPTIONS, until, type Web } from './_host_fixture.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { refusedPort } from './_ports.ts';
import { FakeDesktopWindows } from './_fake_desktop_windows.ts';
import { remoteAib } from './_remote_fixture.ts';

type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENC = new TextEncoder();
const APP = 'window.bindings = { aibDesktop() {} };'; // the desktop app's page: its bridge function bound

/** Answers the page's window calls (POST /api/live/desktop/windows) with the real route over `dw`, as the desktop app does. */
async function bridgeK4(page: Page, dw: FakeDesktopWindows, route: WindowsRoute, calls: Json[]): Promise<void> {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: APP });
  page.listeners.set('Fetch.requestPaused', (p) => {
    const req = p.request as Json;
    const id = String(p.requestId);
    void (async () => {
      let status = 400;
      let body: unknown = { error: 'bad' };
      try {
        const sent = JSON.parse(String(req.postData ?? 'null'));
        calls.push(sent);
        [status, body] = await route.call({ desktopWindows: dw, presence: { leave() {} } as never }, sent);
      } catch (e) {
        body = { error: String(e) };
      }
      const b64 = btoa(String.fromCharCode(...ENC.encode(JSON.stringify(body))));
      await page.send('Fetch.fulfillRequest', {
        requestId: id,
        responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: b64,
      }).catch(() => {});
    })();
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/live/desktop/windows*', requestStage: 'Request' }] });
}

const state = (p: Page) =>
  p.eval<{ project: string; tabs: string[]; title: string; items: string[][] }>(`(() => {
    const W = AgentWorkspaceUI, s = W._state();
    return { project: W.currentProject(), tabs: (s.tabs[W.currentProject()] || []).slice(),
      title: document.getElementById('title').textContent,
      items: W._items().map((i) => [i.key, i.projectKey, i.title]) };
  })()`);

async function typeAndSend(p: Page, text: string): Promise<void> {
  await p.waitFor(`document.body.classList.contains('new-chat') && !!document.getElementById('prompt') && !document.getElementById('prompt').disabled`, 30_000, 'the new-chat view');
  await p.eval(`(() => { const e = document.getElementById('prompt'); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await p.waitFor(`!document.getElementById('send').disabled`, 15_000, 'Send enabled');
  await p.click('#send');
}

const gitInit = async (dir: string) => {
  const r = await new Deno.Command('git', { args: ['init', '-q', dir], stdout: 'null', stderr: 'null' }).output();
  assert(r.success, 'git init');
};

Deno.test({
  name: 'owner steps: new project Act, Act in a new window, restart, new chat there: every window keeps its own project and the chat starts in Act (Windows)',
  ignore: !browserPath,
  ...TEST_OPTIONS,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 15 minutes')), 15 * 60_000);
    });
    await using fx = new Fixture();
    let browser: Browser | undefined;
    let web: Web | undefined;
    try {
      await Promise.race([deadline, windows(fx, (b) => (browser = b), (w) => (web = w))]);
    } finally {
      clearTimeout(giveUp);
      await browser?.close();
      await web?.kill();
    }
  },
});

async function windows(fx: Fixture, keep: (b: Browser) => void, keepWeb: (w: Web) => void): Promise<void> {
  const r = fx.root;
  const brave = `${r}${SEP}braveTV`;
  Deno.mkdirSync(brave, { recursive: true });
  await gitInit(brave);
  const BRAVE = projectKey(brave);
  const parent = `${r}${SEP}projects`;
  Deno.mkdirSync(parent, { recursive: true });
  const act = `${parent}${SEP}Act`;
  const ACT = projectKey(act);
  Deno.writeTextFileSync(
    `${fx.state}${SEP}studio-added-projects.json`,
    JSON.stringify({ version: 1, savedAt: 1, added: { [BRAVE]: { path: brave, at: 1 } } }),
  );
  const home = `${r}${SEP}home`;
  for (const d of ['appdata', 'localappdata', 'home']) Deno.mkdirSync(`${r}${SEP}${d}`, { recursive: true });
  const env = {
    USERPROFILE: home,
    HOME: home,
    APPDATA: `${r}${SEP}appdata`,
    LOCALAPPDATA: `${r}${SEP}localappdata`,
    CODEX_HOME: `${home}${SEP}.codex`,
    AIB_UPDATE_API_BASE: 'http://127.0.0.1:9',
  };
  // The agent host is its own process (as in the app with the keeper): a restart of the web server leaves the chats running.
  Deno.env.set('AIB_FAKE_OWN_SESSION', '1'); // each chat of this test is its own conversation (the agent host inherits both)
  Deno.env.set('AIB_FAKE_UNIQUE_SESSION', '1');
  await fx.startHost();
  const port = refusedPort();
  let web = await fx.startWeb(['--no-auto-reconnect'], { env, port });
  keepWeb(web);
  const listing = async () => (await web.listing()).connections as { cwd: string; projectRoot?: string; id: string }[];
  const cwds = async () => (await listing()).map((c) => c.projectRoot || c.cwd);

  const origin = `http://127.0.0.1:${web.port}`;
  const dw = new FakeDesktopWindows(origin);
  const route = new WindowsRoute();
  const calls: Json[] = [];
  const browser = await Browser.launch();
  keep(browser);
  const open = async (url: string) => {
    const p = await browser.open('about:blank', 1400, 900);
    await bridgeK4(p, dw, route, calls);
    await p.goto(url);
    await p.waitFor(`!!window.AibWindow && !!window.AgentWorkspaceUI && !!document.getElementById('prompt')`, 30_000, 'the page');
    return p;
  };

  // 1. window m shows braveTV and its chat
  let m = await open(dw.windows[0].url);
  await m.waitFor(`AgentWorkspaceUI.paletteProjects().some((p) => p.key === ${JSON.stringify(BRAVE)})`, 30_000, 'braveTV listed');
  await m.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(BRAVE)}), 1`);
  await m.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(BRAVE)}`, 15_000, 'braveTV shown');
  await typeAndSend(m, 'brave first message');
  await until(async () => (await cwds()).some((c) => c.includes('braveTV')), 'the braveTV chat started', 30);
  await m.waitFor(`document.getElementById('title').textContent !== 'New chat'`, 20_000, 'the braveTV chat opens');
  let st = await state(m);
  assertEquals(st.project, BRAVE);
  assert(st.tabs.length === 1, 'braveTV has its chat tab: ' + JSON.stringify(st.tabs));
  const braveChat = st.tabs[0];

  // 2. a NEW project through the real dialog: the folder is made, git init, the window switches to it
  await m.eval(`AgentWorkspaceUI.openNewProject(), 1`);
  await m.waitFor(`!!document.getElementById('npFolder')`, 15_000, 'the New project dialog');
  await m.eval(`(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('npFolder', ${JSON.stringify(parent)});
    set('npName', 'Act');
    return 1;
  })()`);
  await m.waitFor(`!!document.querySelector('.np-form button[type=submit]') && !document.querySelector('.np-form button[type=submit]').disabled`, 20_000, 'Create enabled');
  await m.click('.np-form button[type=submit]');
  await m.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(ACT)}`, 20_000, 'the window shows Act');
  assert(Deno.statSync(`${act}${SEP}.git`).isDirectory, 'Act is a git repo');
  await m.waitFor(`document.body.classList.contains('new-chat')`, 15_000, 'Act opens an empty new chat');
  st = await state(m);
  assertEquals(st.tabs, [], 'Act has no tabs yet: ' + JSON.stringify(st));
  assert(st.title === 'New chat', 'no chat under the Act header: ' + st.title);
  // the server knows Act (the window's project list) before the next step
  await m.waitFor(`!!AgentWorkspaceUI.paletteProjects().find((p) => p.key === ${JSON.stringify(ACT)} && p.path)`, 20_000, 'Act in the list with its folder');

  // 3. Act in a NEW window although it is this window's current project
  const items = await m.eval<string[]>(`(() => {
    AgentWorkspaceUI.openProjectCtx(${JSON.stringify(ACT)}, 200, 200);
    const menu = document.querySelector('.ws-menu[role=menu]');
    const out = menu ? [...menu.querySelectorAll('.ws-menu-item')].map((b) => b.textContent) : [];
    const b = menu && [...menu.querySelectorAll('.ws-menu-item')].find((x) => x.textContent === 'Open in new window');
    if (b) b.click();
    return out;
  })()`);
  assert(items.includes('Open in new window'), 'the menu offers a new window for the current project: ' + JSON.stringify(items));
  await until(() => dw.windows.length === 2, 'the new window was made', 10);
  assertEquals(dw.windows.map((w) => [w.w, w.kind, w.project]), [['m', 'main', null], ['w2', 'project', ACT]]);

  const w2 = await open(dw.windows[1].url);
  await w2.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(ACT)}`, 20_000, 'w2 shows Act');
  await sleep(1500); // let both windows settle (project lists, restore)
  const show = async (label: string, mp: Page, wp: Page) => {
    const a = await state(mp), b = await state(wp);
    assertEquals(b.project, ACT, `${label}: the project window shows Act`);
    assertEquals(a.project, ACT, `${label}: the first window keeps Act (its current project)`);
    for (const [n, s] of [['first', a], ['project', b]] as const) {
      assert(!s.tabs.includes(braveChat), `${label}: the ${n} window has braveTV's chat as a tab under Act: ${JSON.stringify(s.tabs)}`);
      assert(s.title === 'New chat' || !s.title.includes('brave'), `${label}: the ${n} window shows a braveTV chat under Act's header: ${s.title}`);
    }
    const shown = await wp.eval<string>(`document.body.innerText`);
    assert(!shown.includes('brave first message'), `${label}: braveTV's chat text is on w2's screen`);
  };
  await show('after opening w2', m, w2);

  // the owner goes back to braveTV in the first window: the Act window must not follow (both windows share the stores)
  await m.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(BRAVE)}), 1`);
  await m.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(BRAVE)}`, 15_000, 'the first window shows braveTV again');
  await sleep(1500);
  const a1 = await state(m), b1 = await state(w2);
  assertEquals(a1.tabs, [braveChat], 'the first window shows braveTV and its chat: ' + JSON.stringify(a1));
  assertEquals(b1.project, ACT, 'the Act window stays on Act when the other window switches');
  assert(!b1.tabs.includes(braveChat), "the Act window got braveTV's tab: " + JSON.stringify(b1));

  // 4. restart as an update does: the web server dies, the host keeps the chats, the windows reload on their saved URLs
  const saved = dw.list().map((x) => ({ ...x, url: dw.windows.find((y) => y.w === x.w)!.url }));
  await m.close();
  await w2.close();
  await web.kill();
  web = await fx.startWeb(['--no-auto-reconnect'], { env, port });
  keepWeb(web);
  assertEquals(web.port, port, 'the web server comes back on its port');
  const back: Record<string, Page> = {};
  for (const s of saved) back[s.w] = await open(s.url);
  await back.w2.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(ACT)}`, 30_000, 'w2 comes back on Act');
  // the first window comes back on braveTV with its chat; the Act window is still on Act with none of braveTV's tabs
  await back.m.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(BRAVE)}`, 30_000, 'the first window comes back on braveTV');
  await sleep(1500);
  m = back.m;
  const a2 = await state(m), b2 = await state(back.w2);
  assertEquals(a2.tabs, [braveChat], "the first window keeps braveTV's tab: " + JSON.stringify(a2));
  assertEquals(b2.project, ACT, 'the Act window is still on Act');
  assert(!b2.tabs.includes(braveChat), "braveTV's tab is in the Act window after the restart: " + JSON.stringify(b2));
  assert(!(await back.w2.eval<string>(`document.body.innerText`)).includes('brave first message'), "braveTV's chat text is on the Act window's screen");

  // 5. a new chat in the Act window starts in Act's folder
  await back.w2.eval(`document.getElementById('new').click(), 1`);
  await typeAndSend(back.w2, 'act first message');
  await until(async () => (await cwds()).some((c) => c.includes(`${SEP}Act`)), 'the Act chat started', 30);
  await back.w2.waitFor(`!document.body.classList.contains('new-chat')`, 20_000, 'the chat opens in w2').catch(async (e) => { throw new Error(String(e) + ' ' + JSON.stringify(await state(back.w2)) + ' ' + JSON.stringify(await back.w2.eval('document.getElementById("cwd").value + "|" + (document.getElementById("error") || {}).textContent'))); });
  const all = await listing();
  const actChats = all.filter((c) => (c.projectRoot || c.cwd).replaceAll('/', SEP).startsWith(act));
  assertEquals(actChats.length, 1, 'one chat in Act: ' + JSON.stringify(all));
  assertEquals(all.filter((c) => (c.projectRoot || c.cwd).includes('braveTV')).length, 1, 'braveTV still has only its own chat');
  const s2 = await state(back.w2);
  const keyOf = (it: string[]) => it[1];
  const actItems = s2.items.filter((i) => keyOf(i) === ACT);
  assertEquals(actItems.length, 1, 'the new chat is listed under Act: ' + JSON.stringify(s2.items));
  assertEquals(s2.items.filter((i) => keyOf(i) === BRAVE).length, 1, 'braveTV lists only its own chat');
  assertEquals(s2.project, ACT);
  for (const p of Object.values(back)) assertEquals(p.errors, [], 'console errors');
}

// ---- WSL: the second project is a WSL project ---------------------------------------------------------------------------

const WSL_REF = 'wsl://ubuntu/home/u/act';

Deno.test({
  name: 'owner steps with a WSL project as the second project: its own window shows it, braveTV stays out, the first message names the WSL folder and project',
  ignore: !browserPath,
  ...TEST_OPTIONS,
  async fn() {
    const s = await remoteAib();
    s.ctx.transcripts = {
      root: s.state,
      sessions: () => Promise.resolve([]),
      agents: () => Promise.resolve([]),
      sessionCwd: () => Promise.resolve(null),
    } as unknown as typeof s.ctx.transcripts;
    const brave = `${s.root}${SEP}braveTV`;
    Deno.mkdirSync(brave, { recursive: true });
    const BRAVE = projectKey(brave);
    await s.ctx.addedProjects!.add(brave);
    await s.ctx.addedProjects!.add(WSL_REF);
    const chat = (n: number, cwd: string, title: string) => ({
      id: 'c' + n,
      provider: 'claude',
      sessionId: 'sess-' + n,
      cwd,
      busy: false,
      closed: false,
      attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null } as Json,
      subagents: {},
      breadth: { sessionInfo: { title } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }] as Json[],
      permissions: [] as Json[],
      elicitations: [],
    });
    s.chats.push(chat(1, brave, 'brave chat'));
    // a connect answers as the agent host does: the chat starts in the folder it was asked for
    s.answerLive((name, body) => {
      if (name !== 'connect') return [200, { ok: true }];
      const n = s.chats.length + 1;
      s.chats.push(chat(n, String(body.cwd), 'new chat ' + n));
      return [200, { id: 'c' + n, provider: 'claude', sessionId: 'sess-' + n, cwd: body.cwd, ready: true, ok: true }];
    });
    const dw = new FakeDesktopWindows(`http://127.0.0.1:${s.port}`);
    s.ctx.desktopWindows = dw;
    const browser = await Browser.launch();
    const open = async (url: string) => {
      const p = await browser.open('about:blank', 1400, 900);
      await p.send('Page.addScriptToEvaluateOnNewDocument', { source: APP });
      await p.goto(url);
      await p.waitFor(`!!window.AibWindow && !!window.AgentWorkspaceUI && !!document.getElementById('prompt')`, 30_000, 'the page');
      return p;
    };
    try {
      const ACT = 'p:wsl:/ubuntu/home/u/act';
      let m = await open(dw.windows[0].url);
      await m.waitFor(`AgentWorkspaceUI.paletteProjects().some((p) => p.key === ${JSON.stringify(ACT)})`, 30_000, 'the WSL project listed');
      await m.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(BRAVE)}), 1`);
      await m.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(BRAVE)}`, 15_000, 'braveTV shown');
      // the new WSL project is selected in the first window, then opened in a new window
      await m.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(ACT)}), 1`);
      await m.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(ACT)}`, 15_000, 'the window shows the WSL project');
      const offered = await m.eval<boolean>(`(() => {
        AgentWorkspaceUI.openProjectCtx(${JSON.stringify(ACT)}, 200, 200);
        const b = [...document.querySelectorAll('.ws-menu[role=menu] .ws-menu-item')].find((x) => x.textContent === 'Open in new window');
        if (b) b.click();
        return !!b;
      })()`);
      assert(offered, 'Open in new window is offered for the current WSL project');
      await until(() => dw.windows.length === 2, 'the new window was made', 10);
      assertEquals(dw.windows[1].project, ACT);
      const w2 = await open(dw.windows[1].url);
      await w2.waitFor(`AgentWorkspaceUI.currentProject() === ${JSON.stringify(ACT)}`, 20_000, 'w2 shows the WSL project');
      await sleep(1500);
      for (const [n, p] of [['first', m], ['project', w2]] as const) {
        const st = await state(p);
        assertEquals(st.project, ACT, `${n} window shows the WSL project`);
        assert(!st.tabs.includes('claude:sess-1'), `${n} window: braveTV's chat is a tab under the WSL project: ${JSON.stringify(st.tabs)}`);
        assert(!st.title.includes('brave'), `${n} window: a braveTV chat under the WSL header: ${st.title}`);
      }
      // first message in the WSL window
      await w2.eval(`document.getElementById('new').click(), 1`);
      await typeAndSend(w2, 'wsl first message');
      await until(() => s.liveCalls.some(([n]) => n === 'connect'), 'connect asked', 30);
      const [, body] = s.liveCalls.find(([n]) => n === 'connect')!;
      assertEquals(body.cwd, WSL_REF, 'the chat starts in the WSL folder');
      assertEquals(body.project, ACT, 'and names the WSL project');
      await w2.waitFor(`AgentWorkspaceUI._items().some((i) => i.projectKey === ${JSON.stringify(ACT)})`, 20_000, 'the chat listed under the WSL project');
      const st = await state(w2);
      assertEquals(st.items.filter((i) => i[1] === ACT).length, 1);
      assertEquals(st.items.filter((i) => i[1] === BRAVE).length, 1, 'braveTV keeps only its own chat');
      assertEquals(w2.errors, [], 'console errors');
      assertEquals(m.errors, [], 'console errors (first window)');
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
