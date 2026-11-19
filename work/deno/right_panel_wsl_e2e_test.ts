/**
 * The project right panel's Activity for a WSL project (owner rule: WSL parity; design project-right-panel S1). chat.html in a real
 * headless Chrome against a Studio in this process whose fake agent host lists WSL chats (cwd `wsl://ubuntu/home/u/app`, listed with
 * their distro, as the real agent host does) and a Windows chat of another project: three working WSL chats, one waiting on an
 * approval, one idle. Activity lists the three working ones in the order their turns started, never the others; opening another
 * chat of the project moves only the accent; a chat that finishes leaves. The same rules as right_panel_e2e_test.ts, on WSL paths.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/right_panel_wsl_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { remoteStudio } from './_remote_fixture.ts';

type Json = Record<string, unknown>;
const REF = 'wsl://ubuntu/home/u/app';
const WSL = { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/app' };

const SECTIONS = `(() => {
  const g = [...document.querySelectorAll('#projectActivity > .sp-grp')];
  return { keys: g.map((n) => n.dataset.key), focus: g.filter((n) => n.classList.contains('sp-focus')).map((n) => n.dataset.key),
    boxes: g.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); }),
    panelW: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width) };
})()`;
type Sections = { keys: string[]; focus: string[]; boxes: string[]; panelW: number };

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: 'right panel, WSL project: Activity lists the working WSL chats in join order, focus moves only the accent, a finished chat leaves',
  ignore: !browserPath,
  async fn() {
    const s = await remoteStudio();
    // no saved transcripts: the chats are live only (the page lists them from the agent host)
    s.ctx.transcripts = {
      root: s.state,
      sessions: () => Promise.resolve([]),
      agents: () => Promise.resolve([]),
      sessionCwd: () => Promise.resolve(null),
    } as unknown as typeof s.ctx.transcripts;
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const working = (min: number) => ({ state: 'working', needs: 0, turnEndedAt: null, busySince: ago(min) });
    const idle = { state: 'idle', needs: 0, turnEndedAt: null, busySince: null };
    const chat = (n: number, title: string, cwd: string, busy: boolean, attention: Json) => ({
      id: 'c' + n,
      provider: 'claude',
      sessionId: 'sess-' + n,
      cwd,
      busy,
      closed: false,
      attention,
      subagents: {},
      breadth: { sessionInfo: { title } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }],
      permissions: [] as Json[],
      elicitations: [],
      ...(cwd.startsWith('wsl://') ? { wsl: WSL } : {}),
    });
    s.chats.push(
      chat(1, 'Linux second', REF, true, working(5)),
      chat(2, 'Linux first', REF, true, working(9)),
      chat(3, 'Linux third', REF, true, working(2)),
      chat(4, 'Linux asks', REF, true, { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: ago(4) }),
      chat(5, 'Linux idle', REF, false, idle),
      chat(6, 'Windows other project', s.root, true, working(20)),
    );
    // the listing of a WSL chat names its distro (Connection.public: wsl), as the real agent host's does
    const backend = s.ctx.host as unknown as { liveList: () => Promise<Json> };
    const list = backend.liveList.bind(backend);
    backend.liveList = async () => {
      const out = await list();
      for (const c of out.connections as Json[]) {
        const fake = s.chats.find((x) => x.id === c.id) as Json | undefined;
        if (fake?.wsl) c.wsl = fake.wsl;
      }
      return out;
    };
    const browser = await Browser.launch();
    try {
      const page: Page = await browser.open('about:blank', 1600, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      const open = async (key: string) => {
        const sel = `button.connection[data-key="${key}"]`;
        await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 20000, `sidebar row ${key}`).catch(async (e) => {
          throw new Error(`${e.message}: rows ${await page.eval(`JSON.stringify([...document.querySelectorAll('[data-key]')].map((n) => n.tagName + '.' + n.className + '=' + n.dataset.key).slice(0, 30))`)} convs ${await page.eval(`JSON.stringify(StudioChat.state.conversations.map((c) => [c.key, c.provider, c.sessionId, c.projectRoot]))`)} ws ${await page.eval(`JSON.stringify(AgentWorkspaceUI._state())`)} body ${await page.eval(`document.querySelector('aside')?.innerText.slice(0, 300)`)}`);
        });
        await page.click(sel);
        await page.waitFor(`document.querySelector(${JSON.stringify(sel)})?.classList.contains('selected')`, 20000, `${key} open`);
      };
      const sections = () => page.eval<Sections>(SECTIONS);
      const waitKeys = async (want: string[], what: string) => {
        await page.waitFor(`JSON.stringify((${SECTIONS}).keys) === ${JSON.stringify(JSON.stringify(want))}`, 20000, what).catch(async (e) => {
          throw new Error(`${e.message}: ${JSON.stringify(await sections())}`);
        });
      };
      // the rail on the WSL project, then its idle chat: the panel shows that project
      await page.waitFor(`StudioChat.state.conversations.length === 6`, 20000, 'six chats listed');
      const pk = await page.eval<string>(`AgentWorkspaceUI.projectKeyOf(StudioChat.state.conversations.find((c) => c.sessionId === 'sess-5'))`);
      assert(pk && pk !== (await page.eval<string>(`AgentWorkspaceUI.projectKeyOf(StudioChat.state.conversations.find((c) => c.sessionId === 'sess-6'))`)), `the WSL project: ${pk}`);
      await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
      await open('claude:sess-5');
      await waitKeys(['claude:sess-2', 'claude:sess-1', 'claude:sess-3'], 'the working WSL chats, in the order their turns started');
      assertEquals((await sections()).focus, [], 'the open (idle) chat has no section');
      await open('claude:sess-1');
      await page.waitFor(`(${SECTIONS}).focus[0] === 'claude:sess-1'`, 15000, 'the accent on the open chat');
      await new Promise((r) => setTimeout(r, 2500));
      const before = await sections();
      await open('claude:sess-3');
      await page.waitFor(`(${SECTIONS}).focus[0] === 'claude:sess-3'`, 15000, 'the accent moved');
      await new Promise((r) => setTimeout(r, 2500));
      const after = await sections();
      assertEquals(after.keys, before.keys, 'no reorder');
      assertEquals(after.boxes, before.boxes, 'no section moved or changed size');
      assertEquals(after.panelW, before.panelW, 'same width');
      // sess-1 finishes: its section leaves, the others keep their places
      const one = s.chats.find((c) => c.id === 'c1')!;
      one.busy = false;
      one.attention = idle;
      await waitKeys(['claude:sess-2', 'claude:sess-3'], 'a finished WSL chat leaves');
      assert(!(await page.eval<boolean>(`/Windows other project|Linux asks|Linux idle/.test(document.getElementById('projectActivity').innerText)`)), 'never the other project, the asking chat or the idle one');
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
