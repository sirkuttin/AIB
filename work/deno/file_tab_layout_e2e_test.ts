/**
 * Real Studio server + headless Chrome/Edge (own temp profile and data folder, free port, no agent runs). Two owner reports on a
 * ~1700 px window:
 *   1. A file open beside the chat squeezed the Activity column to a sliver: the chat-column cap (resize-ui.js MAX_CHAT, the
 *      conversation stops at 1250 px) widened Activity as if the chat had the whole middle, then the file pane took its share of
 *      what was left. Rule: the cap is about the chat pane's own width. With a file beside the chat (or split panes), Activity
 *      keeps its own width; the file pane and the chat share the middle; Activity never gets narrower because of the cap.
 *   2. A file tab opened in one project stayed (partly) on screen after switching to another project. Switching projects shows
 *      only that project's file tabs and file pane; coming back restores the first project's file as it was.
 */
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { assert, assertEquals } from './_assert.ts';
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

interface Box {
  left: number;
  right: number;
  width: number;
}
interface Widths {
  vw: number;
  side: Box | null;
  chat: Box | null;
  beside: Box | null;
  fileView: Box | null;
  activity: Box | null;
  besideOn: boolean;
  fileOn: boolean;
  fileTabs: string[];
  besideTabs: string[];
}
const MEASURE = `(() => {
  const r = (n) => {
    if (!n || n.hidden) return null;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const b = n.getBoundingClientRect();
    return b.width > 0 && b.height > 0 ? { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) } : null;
  };
  const strip = (sel) => Array.from(document.querySelectorAll(sel)).filter((n) => r(n)).map((n) => n.textContent.replace('×', '').trim());
  return {
    vw: innerWidth,
    side: r(document.querySelector('body > aside')),
    chat: r(document.getElementById('messages')),
    beside: r(document.getElementById('fileBeside')),
    fileView: r(document.getElementById('fileView')),
    activity: r(document.getElementById('subagentsPane')),
    besideOn: document.body.classList.contains('sf-beside-on'),
    fileOn: document.body.classList.contains('sf-file-on'),
    fileTabs: strip('#chatTabs .sf-ftab'),
    besideTabs: strip('#fileBeside .sf-ftab'),
  };
})()`;
const measure = (page: Page) => page.eval<Widths>(MEASURE);

Deno.test({
  name: 'file tabs: a file beside the chat leaves Activity its width; switching projects swaps file tabs and panes cleanly',
  ignore: !browserPath,
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

async function run(fx: Fixture, keep: (b: Browser) => void): Promise<void> {
  const r = fx.root;
  const alpha = `${r}${SEP}Alpha`, beta = `${r}${SEP}Beta`;
  for (const d of [alpha, beta]) Deno.mkdirSync(d, { recursive: true });
  Deno.writeTextFileSync(`${alpha}${SEP}DECISIONS.md`, '# Decisions\n\n' + 'A decision with enough words to wrap a line. '.repeat(40) + '\n');
  Deno.writeTextFileSync(`${alpha}${SEP}notes.txt`, 'alpha notes\n');
  Deno.writeTextFileSync(`${beta}${SEP}README.md`, '# beta\n');
  transcript(`${r}${SEP}claude`, 's-alpha', alpha, 'Alpha work');
  transcript(`${r}${SEP}claude`, 's-beta', beta, 'Beta work');
  const added: Record<string, { path: string; at: number }> = {};
  for (const path of [alpha, beta]) added[projectKey(path)] = { path, at: 1 };
  Deno.writeTextFileSync(`${fx.state}${SEP}studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, added }));
  const ALPHA = key(alpha), BETA = key(beta);
  const ws = {
    v: 1,
    active: ALPHA,
    tabs: { [ALPHA]: ['claude:s-alpha'], [BETA]: ['claude:s-beta'] },
    last: { [ALPHA]: 'claude:s-alpha', [BETA]: 'claude:s-beta' },
    recent: ALPHA,
  };
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
    const page = await browser.open(`http://127.0.0.1:${web.port}/`, 1700, 1000);
    await page.waitFor(`document.getElementById('title').textContent === 'Alpha work'`, 30_000, "Alpha's chat open");
    const title = (t: string) => page.waitFor(`document.getElementById('title').textContent === ${JSON.stringify(t)}`, 15_000, t);
    const settle = () => new Promise((res) => setTimeout(res, 700));

    // ---- 1. a file beside the chat: Activity keeps its width ----------------------------------------------------------------
    const before = await measure(page);
    assert(before.activity && before.activity.width >= 220, `Activity shows before: ${JSON.stringify(before)}`);
    await page.eval(`AgentFilesUI.openFile(AgentFilesUI.currentScope(), 'DECISIONS.md', { beside: true, keep: true })`);
    await page.waitFor(`document.body.classList.contains('sf-beside-on') && !!document.querySelector('#fileBeside .sf-fv-body')`, 15_000, 'file beside');
    await settle();
    const wide = await measure(page);
    const layoutOk = (w: Widths, what: string) => {
      const j = JSON.stringify(w);
      assert(w.activity && w.activity.width >= 220, `${what}: Activity keeps at least its minimum (220 px): ${j}`);
      assert(w.activity!.right <= w.vw + 1 && w.activity!.left >= w.vw - w.activity!.width - 1, `${what}: Activity sits at the right edge: ${j}`);
      assert(w.beside && w.beside.width >= 360, `${what}: the file pane keeps 360 px: ${j}`);
      assert(w.beside!.right <= w.activity!.left + 1, `${what}: the file pane ends where Activity starts (no overlap): ${j}`);
      const mid = w.fileOn ? w.fileView : w.chat; // the middle shows the chat or a file tab
      assert(mid && mid.width >= 380, `${what}: the middle keeps its room: ${j}`);
      assert(mid!.right <= w.beside!.left + 1, `${what}: the middle ends where the file pane starts: ${j}`);
    };
    layoutOk(wide, '1700 px');
    assert(wide.activity!.width >= before.activity!.width - 1, `Activity is not narrower than before the file opened: ${JSON.stringify([before, wide])}`);
    // Window widths across the cap (the chat column stops at MAX_CHAT next to Activity), with the interface zoomed and the chat
    // list hidden: the cap never squeezes the file pane or pushes Activity off the window.
    for (const ui of [100, 125]) {
      await page.eval(`AgentTextSize.setUi(${ui})`);
      // Activity's own width at this interface size (1400 px: room for everything, below the cap)
      await page.viewport(1400, 1000);
      await settle();
      const own = (await measure(page)).activity!.width;
      for (const sideOff of [false, true]) {
        const off = await page.eval<boolean>(`document.body.classList.contains('side-off')`);
        if (off !== sideOff) await page.eval(`ResizeUI.toggleSide ? ResizeUI.toggleSide() : document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))`);
        for (const vw of [1300, 1450, 1700, 2000, 2560]) {
          await page.viewport(vw, 1000);
          await settle();
          const w = await measure(page);
          if (Deno.env.get('AIB_PROBE')) console.log(ui, sideOff, JSON.stringify(w));
          const what = `${vw} px, interface ${ui} %, chat list ${sideOff ? 'hidden' : 'shown'}`;
          layoutOk(w, what);
          // the cap is the chat pane's: it never widens Activity at the cost of the file pane and the chat (where all three have room)
          if (vw >= (ui === 100 ? 1400 : 1700)) assert(Math.abs(w.activity!.width - own) <= 1, `${what}: Activity keeps its own width (${own} px): ${JSON.stringify(w)}`);
        }
      }
    }
    await page.eval(`AgentTextSize.setUi(100)`);
    if (await page.eval<boolean>(`document.body.classList.contains('side-off')`)) {
      await page.eval(`ResizeUI.toggleSide ? ResizeUI.toggleSide() : document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))`);
    }
    await page.viewport(1700, 1000);
    await settle();
    layoutOk(await measure(page), 'back to 1700 px');

    // A file tab in the middle too (Alpha's own strip).
    await page.eval(`AgentFilesUI.openFile(AgentFilesUI.currentScope(), 'notes.txt', { keep: true })`);
    await page.waitFor(`document.body.classList.contains('sf-file-on')`, 15_000, 'file tab in the middle');
    await settle();
    // A file tab filling the middle is not capped either: on a very wide window Activity keeps its own width.
    await page.viewport(2560, 1000);
    await settle();
    const tab2560 = await measure(page);
    assert(tab2560.activity && Math.abs(tab2560.activity.width - before.activity!.width) <= 1, `file tab in the middle, 2560 px: Activity keeps its width: ${JSON.stringify(tab2560)}`);
    await page.viewport(1700, 1000);
    await settle();
    const alphaBefore = await measure(page);
    assertEquals(alphaBefore.fileTabs, ['notes.txt']);
    assertEquals(alphaBefore.besideTabs, ['DECISIONS.md']);

    // ---- 2. switch to Beta: nothing of Alpha's files is on screen or laid out ------------------------------------------------
    await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(BETA)})`);
    await title('Beta work');
    await settle();
    const inBeta = await measure(page);
    const j = JSON.stringify(inBeta);
    assertEquals(inBeta.fileTabs, [], `no Alpha file tab in Beta's strip: ${j}`);
    assertEquals(inBeta.besideTabs, [], `no Alpha file beside the chat in Beta: ${j}`);
    assert(!inBeta.beside && !inBeta.besideOn, `the beside pane is gone: ${j}`);
    assert(!inBeta.fileView && !inBeta.fileOn, `the middle file view is gone: ${j}`);
    const visibleAlpha = await page.eval<string[]>(`Array.from(document.querySelectorAll('#fileBeside *, #fileView *, .sf-ftab'))
      .filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; })
      .map((n) => n.className || n.tagName).slice(0, 10)`);
    assertEquals(visibleAlpha, [], 'no element of the file panes is laid out in Beta');
    assert(inBeta.chat && inBeta.activity && inBeta.chat.right <= inBeta.activity.left + 1, `Beta's chat sits next to Activity: ${j}`);
    assertEquals(
      await page.eval<string>(`getComputedStyle(document.querySelector('main')).paddingRight`),
      '0px',
      'the middle has no room kept for a file pane',
    );

    // ---- back to Alpha: its files are as they were -------------------------------------------------------------------------
    await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(ALPHA)})`);
    await page.waitFor(`document.body.classList.contains('sf-beside-on') && !!document.querySelector('#fileBeside .sf-fv-body')`, 15_000, 'Alpha file beside again');
    await settle();
    const back = await measure(page);
    assertEquals(back.besideTabs, ['DECISIONS.md'], `Alpha's file beside the chat is back: ${JSON.stringify(back)}`);
    assertEquals(back.fileTabs, ['notes.txt'], "Alpha's file tab is back");
    assertEquals(back.fileOn, alphaBefore.fileOn, 'the middle shows what it showed (the file tab)');
    layoutOk(back, 'back in Alpha');
    assertEquals(page.errors, [], 'no page errors');
  } finally {
    await web.kill();
  }
}
