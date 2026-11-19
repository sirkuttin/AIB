/**
 * The project right panel's Activity for a WSL project (owner rule: WSL parity; design project-right-panel S1). chat.html in a real
 * headless Chrome against a Studio in this process whose fake agent host lists WSL chats (cwd `wsl://ubuntu/home/u/app`, listed with
 * their distro, as the real agent host does) and a Windows chat of another project: three working WSL chats, one waiting on an
 * approval, two idle (one finished two helpers). Activity lists the three working ones in the order their turns started; the
 * project's other chats are collapsed head lines below them (a caret and "N finished" only for the one that finished helpers;
 * expanding lists them), never the other project's; opening another chat of the project moves only the accent; a chat that finishes
 * goes to the top of the idle group and back to the end of the working ones when it starts again. The same rules as
 * right_panel_e2e_test.ts, on WSL paths.
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
/** The idle group below: keys, each head's caret|count|enabled, expanded ones, visible helper titles, boxes, the accent. */
const IDLES = `(() => {
  const g = [...document.querySelectorAll('#projectActivity > .sp-idle-list > .sp-idle')];
  const vis = (n) => !!n && n.getClientRects().length > 0;
  return { keys: g.map((n) => n.dataset.key),
    heads: g.map((n) => { const h = n.querySelector('.sp-ihead'); return [h.querySelector('.sp-caret').textContent, h.querySelector('.sp-count').textContent, h.disabled ? 'off' : 'on'].join('|'); }),
    open: g.filter((n) => vis(n.querySelector('.sp-idle-body'))).map((n) => n.dataset.key),
    titles: g.map((n) => [...n.querySelectorAll('.sp-idle-body .subagent-card')].filter(vis).map((c) => c.querySelector('.sa-title')?.textContent || '')),
    boxes: g.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); }),
    focus: g.filter((n) => n.classList.contains('sp-focus')).map((n) => n.dataset.key) };
})()`;
type Idles = { keys: string[]; heads: string[]; open: string[]; titles: string[][]; boxes: string[]; focus: string[] };

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
      chat(5, 'Linux idle', REF, false, { ...idle, turnEndedAt: ago(30) }),
      chat(6, 'Windows other project', s.root, true, working(20)),
      chat(7, 'Linux done', REF, false, { ...idle, turnEndedAt: ago(10) }),
    );
    // the idle chat that finished two helpers (their subagent_update events, as a live chat's stream carries them)
    const done = s.chats.find((c) => c.id === 'c7')! as unknown as { events: Json[] };
    ['Port the parser', 'Check the docs'].forEach((description, i) =>
      done.events.push({ seq: 2 + i, kind: 'update', time: 2 + i, data: { update: { sessionUpdate: 'subagent_update', subagent: { sessionId: 'wsl-helper-' + i, description, state: 'completed' } } } })
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
      const idles = () => page.eval<Idles>(IDLES);
      const waitIdle = async (test: string, what: string) => {
        await page.waitFor(`(() => { const i = ${IDLES}; return ${test}; })()`, 20000, what).catch(async (e) => {
          throw new Error(`${e.message}: ${JSON.stringify(await idles())}`);
        });
      };
      await page.waitFor(`StudioChat.state.conversations.length === 7`, 20000, 'seven chats listed');
      const pk = await page.eval<string>(`AgentWorkspaceUI.projectKeyOf(StudioChat.state.conversations.find((c) => c.sessionId === 'sess-5'))`);
      assert(pk && pk !== (await page.eval<string>(`AgentWorkspaceUI.projectKeyOf(StudioChat.state.conversations.find((c) => c.sessionId === 'sess-6'))`)), `the WSL project: ${pk}`);
      await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
      await open('claude:sess-5');
      await waitKeys(['claude:sess-2', 'claude:sess-1', 'claude:sess-3'], 'the working WSL chats, in the order their turns started');
      assertEquals((await sections()).focus, [], 'the open (idle) chat has no working section');
      // the idle WSL chats below, collapsed: the one that finished helpers has a caret and a count, the plain idle one neither
      await waitIdle(`i.keys.includes('claude:sess-7') && i.keys.includes('claude:sess-5') && i.heads[i.keys.indexOf('claude:sess-7')] === '▸|2 finished|on'`, 'the idle WSL chats');
      let i = await idles();
      assert(i.keys.indexOf('claude:sess-7') < i.keys.indexOf('claude:sess-5'), `the more recently active first: ${JSON.stringify(i.keys)}`);
      assert(!i.keys.includes('claude:sess-6'), 'never the other project');
      assertEquals(i.heads[i.keys.indexOf('claude:sess-5')], '||off', 'nothing finished: no caret, no count');
      assertEquals([i.open, i.focus], [[], ['claude:sess-5']], 'collapsed; the open idle chat has the accent');
      await page.click(`#projectActivity > .sp-idle-list > .sp-idle[data-key="claude:sess-7"] .sp-ihead`);
      await waitIdle(`i.open[0] === 'claude:sess-7' && i.titles[i.keys.indexOf('claude:sess-7')].length === 2`, 'expanded: the two finished helpers');
      await open('claude:sess-1');
      await page.waitFor(`(${SECTIONS}).focus[0] === 'claude:sess-1'`, 15000, 'the accent on the open chat');
      await new Promise((r) => setTimeout(r, 2500));
      const before = await sections(), idleBefore = await idles();
      await open('claude:sess-3');
      await page.waitFor(`(${SECTIONS}).focus[0] === 'claude:sess-3'`, 15000, 'the accent moved');
      await new Promise((r) => setTimeout(r, 2500));
      const after = await sections();
      assertEquals(after.keys, before.keys, 'no reorder');
      assertEquals(after.boxes, before.boxes, 'no section moved or changed size');
      assertEquals(after.panelW, before.panelW, 'same width');
      // opening an idle chat: only the accent moves (it does not expand, nothing moves)
      await open('claude:sess-5');
      await page.waitFor(`(${IDLES}).focus[0] === 'claude:sess-5'`, 15000, 'the accent on the idle chat');
      await new Promise((r) => setTimeout(r, 2500));
      i = await idles();
      assertEquals([i.keys, i.boxes, i.open, i.heads], [idleBefore.keys, idleBefore.boxes, idleBefore.open, idleBefore.heads], 'the idle group did not change');
      assertEquals((await sections()).boxes, before.boxes, 'the working sections did not change');
      // sess-1 finishes: its section leaves for the top of the idle group, the others keep their places
      const one = s.chats.find((c) => c.id === 'c1')!;
      one.busy = false;
      one.attention = idle;
      await waitKeys(['claude:sess-2', 'claude:sess-3'], 'a finished WSL chat leaves');
      await waitIdle(`i.keys[0] === 'claude:sess-1'`, 'on top of the idle group');
      // and starts again: back at the end of the working sections
      one.busy = true;
      one.attention = working(0);
      await waitKeys(['claude:sess-2', 'claude:sess-3', 'claude:sess-1'], 'working again: at the end');
      await waitIdle(`!i.keys.includes('claude:sess-1')`, 'out of the idle group');
      assert(!(await page.eval<boolean>(`/Windows other project/.test(document.getElementById('projectActivity').innerText)`)), 'never the other project');
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
