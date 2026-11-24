/**
 * The Docs tab for a WSL project (owner rule: WSL parity; design project-right-panel S4): chat.html in a real headless Chrome against
 * a Studio in this process whose fake agent host lists a WSL chat (cwd `wsl://ubuntu/home/u/app`) and whose docs live "in the distro"
 * through the fake WSL helper (FakeWslHost with the real helper's docs.fs on a temp folder; needs no WSL, no distro and no
 * wsl.exe). The same rules as docs_tab_e2e_test.ts: the project's docs are listed newest edited first, a doc opens in the Docs tab
 * (never as a middle tab), in the full editor with the text the distro holds, and ⤢ moves it to a middle tab.
 *
 * Run (from app): deno test -A ../../work/deno/docs_tab_wsl_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { remoteStudio } from './_remote_fixture.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { installWslDocFs } from '../../app/server/wsl/docs.ts';
import { docsMethods } from '../../app/server/wsl/helper/docs.ts';
import { runDocTool } from '../../app/server/docs/tools.ts';

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-docs-tab');
const REF = 'wsl://ubuntu/home/u/app';
const LINUX = '/home/u/app';
const WSL = { distro: 'ubuntu', name: 'Ubuntu', linuxPath: LINUX };

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: 'Docs tab, WSL project: the distro\'s docs are listed, open in the Docs tab (editable, the distro\'s text), and ⤢ moves one to a middle tab',
  ignore: !browserPath,
  async fn() {
    const s = await remoteStudio();
    const folder = `${s.root}${Deno.build.os === 'windows' ? '\\' : '/'}distro-app`;
    await Deno.mkdir(folder, { recursive: true });
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.folders.set(LINUX, folder);
    const methods = docsMethods(
      { env: () => Promise.resolve({ env: { HOME: '/home/u' }, shell: '/bin/bash', home: '/home/u', arch: 'x86_64' }) },
      { resolve: (p: string) => host.windowsFor(p) },
    );
    host.handlers['docs.fs'] = (p: unknown) => methods['docs.fs'](p as never);
    setWslHostResolver((d: string) => (d === 'ubuntu' ? host : null));
    installWslDocFs();
    s.ctx.transcripts = {
      root: s.state,
      sessions: () => Promise.resolve([]),
      agents: () => Promise.resolve([]),
      sessionCwd: () => Promise.resolve(null),
    } as unknown as typeof s.ctx.transcripts;
    s.chats.push({
      id: 'c1',
      provider: 'claude',
      sessionId: 'sess-1',
      cwd: REF,
      busy: false,
      closed: false,
      attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
      subagents: {},
      breadth: { sessionInfo: { title: 'Linux chat' } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on the docs' } }],
      permissions: [],
      elicitations: [],
      wsl: WSL,
    } as never);
    const backend = s.ctx.host as unknown as { liveList: () => Promise<Record<string, unknown>> };
    const list = backend.liveList.bind(backend);
    backend.liveList = async () => {
      const out = await list();
      for (const c of out.connections as Record<string, unknown>[]) c.wsl = WSL;
      return out;
    };
    const tool = async (name: string, args: Record<string, unknown>) => {
      const [ok, result] = await runDocTool(s.ctx.docs, REF, 'claude', name, args, 'claude:sess-1');
      assert(ok, `${name}: ${JSON.stringify(result)}`);
      return result;
    };
    const browser = await Browser.launch();
    try {
      await tool('doc_create', { doc: 'Linux plan', markdown: '# Linux plan\n\nDistro words.\n' });
      await new Promise((r) => setTimeout(r, 1100));
      await tool('doc_create', { doc: 'Linux notes', markdown: '# Linux notes\n\nOther words.\n' });
      const onDisk = [...Deno.readDirSync(`${folder}${Deno.build.os === 'windows' ? '\\' : '/'}aib-docs`)].map((e) => e.name).sort();
      assert(onDisk.length >= 2, `the docs are in the distro's folder: ${onDisk}`);
      const page: Page = await browser.open('about:blank', 1600, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      const sel = 'button.connection[data-key="claude:sess-1"]';
      await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 20000, 'the WSL chat in the sidebar');
      await page.click(sel);
      await page.waitFor(`document.querySelector(${JSON.stringify(sel)})?.classList.contains('selected')`, 20000, 'the WSL chat open');
      await page.click('#paneTab-docs');
      await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 2`, 20000, 'the distro\'s two docs listed');
      const rows = await page.eval<string[]>(`[...document.querySelectorAll('#docsPane .dt-row .dt-row-title')].map((n) => n.textContent)`);
      assertEquals(rows, ['Linux notes', 'Linux plan'], 'newest edited first');
      await page.click('#docsPane .dt-row[data-doc="linux-plan"]');
      await page.waitFor(
        `(() => { const f = document.querySelector('#docsPane iframe.dt-frame'), d = f && f.contentDocument; return !!(d && d.querySelector('#docApp .ProseMirror[contenteditable="true"]') && d.querySelector('#docEditor').innerText.includes('Distro words.')); })()`,
        30000,
        'the editor with the distro\'s text',
      );
      assert(await page.eval<boolean>(`document.querySelectorAll('.sf-ftab').length === 0`), 'no middle tab');
      await page.click('#docsPane .dt-wide');
      await page.waitFor(`document.querySelectorAll('.sf-ftab').length === 1`, 10000, 'a middle tab after ⤢');
      assertEquals(await page.eval<number>(`document.querySelectorAll('#docsPane iframe').length`), 0, 'the panel is back to its list');
      assertEquals(page.errors.length, 0, `console errors: ${page.errors.join(' | ')}`);
    } finally {
      await browser.close();
      setWslHostResolver(null);
      await s.close();
    }
  },
});
