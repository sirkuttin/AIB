/**
 * The right panel's Artifacts tab is the project's (owner decision 1a, 2026-11-18; design aib-shared/designs/project-right-panel, S3).
 *
 * Artifacts lists every artifact of every chat of the project, newest first, each row tagged with its chat (a chip: agent badge and
 * chat name). "All chats" narrows the list to one chat; the choice is kept per project and window (it survives a reload) and focus
 * never sets it. The tab's badge counts the project's artifacts. Opening another chat moves only the accent: the list, the filter
 * and the badge stay. The artifact's `project` field is computed when listing, nothing is migrated on disk: an old artifact with no
 * project (and a WSL artifact) is attributed through the chat that made it, and an artifact made in a worktree maps to its project.
 * An artifact of another project never shows.
 *
 * Two variants: a Windows project (a git repository with a real worktree) and a WSL project (fake chats at wsl://ubuntu/home/u/app,
 * as in right_panel_wsl_e2e_test.ts; no distro is needed). A real AIB in this process (temp state folder, free port; never the
 * live ports), headless Chrome or Edge.
 *
 * Run (from app): deno test -A ../../work/deno/project_artifacts_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { remoteAib } from './_remote_fixture.ts';
import { git, HAVE_GIT, write } from './_git_repo.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';
const OTHER_REF = 'wsl://ubuntu/home/u/other';
const WSL = { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/app' };
const NAMES = ['Auth work', 'Docs sweep', 'Perf pass'];

/** The picker's rows (artifact id and chip), its filter head's text, and the badge. */
const PICKER = `(() => {
  const pop = document.querySelector('#artifactsPane .ar-pop:not(.ar-rowmenu)');
  const open = !!pop && !pop.hidden;
  return { open, badge: document.querySelector('#paneTab-artifacts .pane-badge')?.hidden === false ? document.querySelector('#paneTab-artifacts .pane-badge').textContent : '',
    rows: open ? [...pop.querySelectorAll('.ar-it[data-id]')].map((r) => [r.dataset.id, r.querySelector('.ar-chip-name')?.textContent || '', r.querySelector('.ar-chip-agent')?.textContent || '']) : [],
    filter: open ? pop.querySelector('.ar-filter')?.innerText.replace(/\\s+/g, ' ').trim() || '' : '',
    groups: open ? [...pop.querySelectorAll('.ar-gh')].map((g) => g.textContent) : [] };
})()`;
type Picker = { open: boolean; badge: string; rows: [string, string, string][]; filter: string; groups: string[] };

function scenario(name: string, wsl: boolean) {
  Deno.test({
    sanitizeResources: false,
    sanitizeOps: false,
    name,
    ignore: !browserPath || (!wsl && !HAVE_GIT),
    async fn() {
      const s = await remoteAib();
      s.ctx.transcripts = {
        root: s.state,
        sessions: () => Promise.resolve([]),
        agents: () => Promise.resolve([]),
        sessionCwd: () => Promise.resolve(null),
      } as unknown as typeof s.ctx.transcripts;
      // the project: a WSL ref, or a git repository with one worktree (a subagent's copy)
      let project = REF, other = OTHER_REF, worktree = '';
      if (!wsl) {
        project = `${s.root}${SEP}proj`;
        other = `${s.root}${SEP}other`;
        worktree = `${s.root}${SEP}proj-wt`;
        for (const dir of [project, other]) Deno.mkdirSync(dir, { recursive: true });
        git(project, 'init', '-q');
        write(`${project}${SEP}a.txt`, 'a\n');
        git(project, 'add', '-A');
        git(project, 'commit', '-q', '-m', 'base');
        git(project, 'worktree', 'add', '-q', '-b', 'sub-branch', worktree);
      }
      const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      const idle = { state: 'idle', needs: 0, turnEndedAt: ago(5), busySince: null };
      const chat = (n: number, title: string, cwd: string) => ({
        id: 'c' + n,
        provider: 'claude',
        sessionId: 'sess-' + n,
        cwd,
        busy: false,
        closed: false,
        attention: idle,
        subagents: {},
        breadth: { sessionInfo: { title } },
        events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }],
        permissions: [] as Json[],
        elicitations: [],
        ...(cwd.startsWith('wsl://') ? { wsl: WSL } : {}),
      });
      s.chats.push(chat(1, NAMES[0], project), chat(2, NAMES[1], project), chat(3, NAMES[2], project), chat(4, 'Elsewhere', other));
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
      // The artifacts, written to the store as AIB left them: newest first is W, B, C, A, old.
      const store = s.ctx.artifacts!.store;
      const now = Date.now() / 1000;
      const made = (chatN: number, title: string, minutesAgo: number, projectField: string | null) => {
        const m = store.create(`claude:sess-${chatN}`, title, 'html', 'index.html', new TextEncoder().encode(`<h1>${title}</h1>`), { project: projectField });
        m.updatedAt = now - minutesAgo * 60;
        store.save(m);
        return String(m.id);
      };
      const ids = {
        old: made(1, 'Old from A', 50, null), // an artifact from before `project` was kept: null
        a: made(1, 'Auth notes', 40, wsl ? null : project), // a WSL artifact has no project either
        c: made(3, 'Perf chart', 30, wsl ? null : project),
        b: made(2, 'Docs plan', 20, wsl ? null : project),
        w: wsl ? '' : made(2, 'Worktree draft', 10, worktree), // made in a subagent's worktree: the project field holds that path
        x: made(4, 'Not this project', 5, wsl ? null : other),
      };
      const expected = wsl ? [ids.b, ids.c, ids.a, ids.old] : [ids.w, ids.b, ids.c, ids.a, ids.old];
      const chatOfId: Record<string, string> = {
        [ids.old]: NAMES[0], [ids.a]: NAMES[0], [ids.c]: NAMES[2], [ids.b]: NAMES[1], [ids.w]: NAMES[1],
      };
      const browser = await Browser.launch();
      try {
        const page: Page = await browser.open('about:blank', 1600, 900);
        const url = `http://127.0.0.1:${s.port}/chat.html`;
        await page.goto(url);
        const open = async (key: string) => {
          const sel = `button.connection[data-key="${key}"]`;
          await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 20000, `sidebar row ${key}`);
          await page.click(sel);
          await page.waitFor(`document.querySelector(${JSON.stringify(sel)})?.classList.contains('selected')`, 20000, `${key} open`);
        };
        const picker = () => page.eval<Picker>(PICKER);
        const openPicker = async () => {
          if (!(await picker()).open) await page.click('#artifactsPane .ar-pick');
          await page.waitFor(`(${PICKER}).open`, 10000, 'the picker is open');
        };
        const closePicker = async () => {
          await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await page.waitFor(`!(${PICKER}).open`, 5000, 'the picker is closed');
        };
        await page.waitFor(`StudioChat.state.conversations.length === 4`, 20000, 'four chats listed');
        const pk = await page.eval<string>(`AgentWorkspaceUI.projectKeyOf(StudioChat.state.conversations.find((c) => c.sessionId === 'sess-1'))`);
        assert(pk, 'the project key');
        await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
        await open('claude:sess-1');
        await page.click('#paneTab-artifacts');
        await page.waitFor(`document.querySelector('#paneTab-artifacts .pane-badge')?.textContent === ${JSON.stringify(String(expected.length))}`, 20000, 'the badge counts the project').catch(
          async (e) => {
            throw new Error(`${e.message}: ${await page.eval('ArtifactsUI && JSON.stringify(ArtifactsUI.state().list.map((a) => a.title))')} ${JSON.stringify(await page.eval('ArtifactsUI.state().project'))}`);
          },
        );

        // 3 chats' artifacts: one list, newest first, each row tagged with its chat; the old (null project) and the worktree one included,
        // the other project's left out
        await openPicker();
        const first = await picker();
        assertEquals(first.rows.map((r) => r[0]), expected, 'one list, newest first (an old null-project artifact and a worktree one included)');
        assertEquals(first.rows.map((r) => r[1]), expected.map((id) => chatOfId[id]), 'each row tagged with its chat');
        assert(first.rows.every((r) => r[2] === 'Claude Code'), `the agent badge: ${JSON.stringify(first.rows)}`);
        assert(!first.rows.some((r) => r[0] === ids.x), 'an artifact of another project never shows');
        assertEquals(first.groups, ['Newest first']);
        assert(/All chats/.test(first.filter), `the filter says All chats: ${first.filter}`);
        assertEquals(first.badge, String(expected.length));
        // the server's own answer: every artifact carries its chat and the project it was attributed to
        const served = await page.eval<Json[]>(`(async () => {
          const t = (await (await fetch('/api/live/bootstrap', window.AIBPageAuth ? AIBPageAuth.init() : undefined)).json()).token;
          const r = await fetch('/api/live/project/artifacts?id=c3', { headers: { 'X-Studio-Token': t } });
          return (await r.json()).artifacts.map((a) => ({ id: a.id, chat: a.conversationId, project: a.project }));
        })()`);
        assertEquals(served.map((a) => a.id), expected);
        assertEquals(new Set(served.map((a) => a.project)).size, 1, 'every artifact is attributed to the one project');

        // the filter narrows to one chat
        await page.click('#artifactsPane .ar-pop .ar-filter');
        await page.click('#artifactsPane .ar-pop .ar-fopt[data-key="chat:claude:sess-2"]');
        await page.waitFor(`JSON.stringify((${PICKER}).rows.map((r) => r[0])) === ${JSON.stringify(JSON.stringify(wsl ? [ids.b] : [ids.w, ids.b]))}`, 10000, 'only the second chat');
        const narrowed = await picker();
        assert(/Docs sweep/.test(narrowed.filter), `the filter names the chat: ${narrowed.filter}`);
        assertEquals(narrowed.badge, String(expected.length), 'the badge still counts the project');
        await closePicker();

        // focus changes nothing: another chat of the project moves only the accent
        await open('claude:sess-3');
        await new Promise((r) => setTimeout(r, 2500));
        await openPicker();
        const afterFocus = await picker();
        assertEquals(afterFocus.rows, narrowed.rows, 'the list did not change when another chat opened');
        assertEquals(afterFocus.filter, narrowed.filter, 'neither did the filter');
        assertEquals(afterFocus.badge, narrowed.badge, 'nor the badge');
        await closePicker();

        // the choice is kept per project and window: it survives a reload
        await page.goto(url);
        await page.waitFor(`StudioChat.state.conversations.length === 4`, 20000, 'chats listed again');
        await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
        await open('claude:sess-2');
        await page.click('#paneTab-artifacts');
        await page.waitFor(`document.querySelector('#paneTab-artifacts .pane-badge')?.textContent === ${JSON.stringify(String(expected.length))}`, 20000, 'the badge after the reload');
        await openPicker();
        const reloaded = await picker();
        assert(/Docs sweep/.test(reloaded.filter), `the filter after a reload: ${reloaded.filter}`);
        assertEquals(reloaded.rows.map((r) => r[0]), narrowed.rows.map((r) => r[0]), 'the narrowed list after a reload');
        // back to all chats: the whole project again
        await page.click('#artifactsPane .ar-pop .ar-filter');
        await page.click('#artifactsPane .ar-pop .ar-fopt[data-key="chat:"]');
        await page.waitFor(`(${PICKER}).rows.length === ${expected.length}`, 10000, 'all chats again');
        await closePicker();
        assertEquals(page.errors, [], 'console errors');
        await page.close();
      } finally {
        await browser.close();
        await s.close();
      }
    },
  });
}

scenario('project Artifacts: 3 chats give one list newest first, tagged; the filter narrows and survives a reload; focus changes nothing; null-project and worktree artifacts map to the project', false);
scenario('project Artifacts, WSL project: the same list, tags, filter and focus rules (WSL artifacts carry no project)', true);
