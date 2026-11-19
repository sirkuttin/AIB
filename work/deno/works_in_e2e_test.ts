/**
 * Chats work in the project folder, the page part (build plan 1b, sections 1.2-1.4; owner decision 2026-11-16: no per-chat Own copy).
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), scripted live chats, headless Chrome or
 * Edge. The Changes replies are answered in the page by a fetch stub installed before the page's own scripts run; connect
 * requests are recorded and passed on.
 *
 * 20. The New chat screen has no Works in chip, no note under the folder line, and the folder line is "<folder> · <branch>", as
 *     before the chip was added; also while another folder chat is working (no pre-set, no amber warning). The first message's
 *     connect carries no ownCopy.
 * 24. The project's Changes tab (right panel slice S2): the fixed header, no Merge or Discard, the footer line. Another chat of the
 *     project (even one that was made in its own copy, stood in for by a stubbed reply) changes nothing in the tab.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/works_in_e2e_test.ts   (ignored without Chrome or Edge)
 * AIB_WORKS_IN_SHOTS=<folder> saves a screenshot of each state there.
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, type Page, settle } from './_scroll_lab.ts';

const SHOTS = Deno.env.get('AIB_WORKS_IN_SHOTS') || '';

/** The stub: /api/live/project/changes and /api/live/worktree answer from window.__changes (by chat id). Connect bodies go to __connects. */
const STUB = `(() => {
  const real = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.__connects = [];
  window.fetch = (url, init) => {
    const u = new URL(String(url), location.href);
    const id = u.searchParams.get('id') || '';
    const ch = window.__changes && window.__changes[id];
    if (u.pathname === '/api/live/project/changes' && ch) {
      const sum = { files: ch.files.length, added: ch.files.reduce((a, f) => a + f.added, 0), removed: ch.files.reduce((a, f) => a + f.removed, 0) };
      return Promise.resolve(json({ git: true, sections: [], left: [], main: { id: 'main', kind: 'main', name: 'Project folder', branch: 'main', state: 'active',
        expanded: true, git: true, counts: sum, changes: { git: true, scope: 'uncommitted', root: '/r', prefix: '', files: ch.files, filesTotal: sum.files, totals: sum } } }));
    }
    if (u.pathname === '/api/live/worktree' && ch)
      return Promise.resolve(json(ch.worktree ? { worktree: true, enabled: true, state: 'ready', base: 'main', label: 'Merge' } : { worktree: false }));
    if (u.pathname === '/api/live/connect' && init && init.body) window.__connects.push(JSON.parse(init.body));
    return real(url, init);
  };
})()`;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const r = await page.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
  Deno.mkdirSync(SHOTS, { recursive: true });
  Deno.writeFileSync(`${SHOTS}\\${name}.png`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
}

function worksInTest(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1600, 900);
      try {
        await lab.page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
        await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
        await lab.page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
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

/** The New chat screen in the workspace project, once its folder line names the branch. */
async function newChat(page: Page) {
  await page.eval(`document.getElementById('new').click()`);
  await page.waitFor(`document.getElementById('title').textContent === 'New chat' && / · main$/.test(document.getElementById('ncFolder').textContent)`, 15000, 'New chat');
}
const screen = (page: Page) =>
  page.eval<{ chip: boolean; note: boolean; folder: string; nodes: number; chips: string[]; menuNames: string[] }>(`(() => {
    const f = document.getElementById('ncFolder');
    return { chip: !!document.getElementById('chip-worksin') || !!document.querySelector('.chip-worksin'),
      note: !!document.getElementById('ncWorksNote') || !!document.querySelector('.nc-works-note'),
      folder: f.textContent, nodes: f.childNodes.length,
      chips: [...document.querySelectorAll('#composerChips .chip-k')].map((k) => k.textContent),
      menuNames: [...document.querySelectorAll('.chip-menu .chip-menu-name')].map((n) => n.textContent) };
  })()`);

worksInTest('20: New chat has no Works in chip or note, the folder line is "<folder> · main", connect sends no ownCopy', async (lab) => {
  const page = lab.page;
  // with Git, so the folder line names a branch (the line the chip once changed)
  const git = (...args: string[]) => new Deno.Command('git', { args, cwd: lab.fx.workspace, stdout: 'null', stderr: 'null' }).outputSync();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  await newChat(page);
  const s = await screen(page);
  assertEquals([s.chip, s.note, s.nodes], [false, false, 1], JSON.stringify(s));
  assertEquals(s.folder, `${lab.fx.workspace} · main`);
  assert(!s.chips.some((k) => /works in/i.test(k)), `chips: ${s.chips}`);
  assert(!(await page.eval<string>(`document.body.innerText`)).includes('Own copy'), 'no "Own copy" anywhere on the screen');
  await shot(page, '20-new-chat');

  // another folder chat working in the project: the screen is the same (no pre-set, no amber warning)
  const busy: Chat = await lab.chat();
  await busy.start();
  busy.say('Working on it BUSYCHAT');
  await lab.select(busy);
  await newChat(page);
  await settle(1500); // a list poll or two: the page knows the other chat is busy
  const b = await screen(page);
  assertEquals([b.chip, b.note, b.nodes, b.folder], [false, false, 1, s.folder], JSON.stringify(b));
  assertEquals(b.chips, s.chips, 'the same chips');
  await shot(page, '20-busy');

  // the first message: connect goes out without ownCopy
  await page.eval(`(() => { const p = document.getElementById('prompt'); p.value = 'hello'; p.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.eval(`document.getElementById('send').click()`);
  await page.waitFor(`window.__connects.length > 0`, 15000, 'connect sent');
  const sent = await page.eval<Record<string, unknown>>(`window.__connects[0]`);
  assertEquals('ownCopy' in sent, false, JSON.stringify(sent));
  assertEquals(sent.resume, '');
  busy.end();
  await settle(300);
});

worksInTest('24: the project\'s Changes tab: fixed header, no Merge or Discard, the footer line; another chat changes nothing', async (lab) => {
  const page = lab.page;
  const folder = await lab.chat();
  await folder.start();
  folder.say('Folder chat FOLDERCHAT');
  folder.end();
  const copy = await lab.chat(); // the same folder: its stubbed Changes reply carries a worktree, as a copy chat's does
  await copy.start();
  copy.say('Copy chat COPYCHAT');
  copy.end();
  const files = [{ path: 'src/app.ts', status: 'M', added: 4, removed: 1 }];
  await page.eval(`window.__changes = ${JSON.stringify({
    [folder.id]: { git: true, scope: 'uncommitted', files },
    [copy.id]: { git: true, scope: 'branch', files, worktree: { branch: 'studio/copy-1' } },
  })}`);
  await lab.select(folder);
  await page.eval(`document.getElementById('paneTab-changes').click()`);
  await page.waitFor(`document.querySelectorAll('#changesPane .cg-file').length === 1`, 15000, 'folder chat files');
  const f = await page.eval<{ scope: string; foot: string; footShown: boolean; buttons: number }>(`(() => {
    const p = document.getElementById('changesPane'), line = p.querySelector('.cg-foot-folder');
    return { scope: p.querySelector('.cg-scope').textContent, foot: line.hidden ? '' : line.textContent, footShown: !p.querySelector('.cg-foot').hidden,
      buttons: p.querySelectorAll('.cg-foot button, .cg-merge-btn, .cg-discard').length };
  })()`);
  assertEquals(f, {
    scope: 'Project',
    foot: "Nothing to merge: edits go straight into the project folder, from any chat. Ask the agent to commit or undo.",
    footShown: true,
    buttons: 0,
  });
  // the header fits the column at its default width: nothing cut
  const fit = await page.eval<{ sw: number; cw: number; panel: number; sum: string }>(`(() => {
    const s = document.querySelector('#changesPane .cg-scope'), sum = document.querySelector('#changesPane .cg-sum');
    return { sw: s.scrollWidth, cw: s.clientWidth, panel: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
      sum: sum.scrollWidth <= sum.clientWidth ? 'whole' : 'cut' };
  })()`);
  assert(fit.panel === 320, `the default panel width (320 px, owner 2026-11-18): ${fit.panel}`);
  assert(fit.sw <= fit.cw, `the header is cut at ${fit.panel} px: ${fit.sw} > ${fit.cw}`);
  assertEquals(fit.sum, 'whole', 'the file count is not cut either');
  await shot(page, '24-folder-changes');
  const panelW = await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`);

  await lab.select(copy);
  await settle(1500);
  // the panel is the project's: another chat (here one that stood in for an old copy chat) shows the same Changes, same footer
  const c = await page.eval<{ scope: string; files: number; foot: string; buttons: number }>(`(() => {
    const p = document.getElementById('changesPane'), line = p.querySelector('.cg-foot-folder');
    return { scope: p.querySelector('.cg-scope').textContent, files: p.querySelectorAll('.cg-file').length, foot: line.hidden ? '' : line.textContent,
      buttons: p.querySelectorAll('.cg-foot button, .cg-merge-btn, .cg-discard').length };
  })()`);
  assertEquals(c, { scope: 'Project', files: 1, foot: f.foot, buttons: 0 });
  await shot(page, '24-copy-changes');
  assertEquals(
    await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`),
    panelW,
    'the right panel keeps its width when the chat changes',
  );
});
