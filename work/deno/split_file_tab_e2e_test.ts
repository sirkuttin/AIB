/**
 * A file tab in a split (owner, 2026-11-17): two chats open, a file opened as a third tab, the second chat dragged out into a
 * side-by-side split. Clicking the file tab used to hide the split stage: the file took the whole window, both panes and both strips
 * went, with no way back. Now the file shows inside the first pane (the one whose strip holds the file tab), the other pane and both
 * strips stay, and the first pane's chat tab brings the chat back.
 *
 * A real Studio (temp state and workspace, free port; never the live ports), the scripted agent, a headless Chrome/Edge.
 * Run (from app): deno task test --jobs 1 split_file_tab
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, Lab, type Page, settle, shown } from './_scroll_lab.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';

/** What is on screen: both panes and strips visible, where the file view and the chats are. */
const LAYOUT = `(() => {
  const vis = (n) => { if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 40 && r.height > 20 && !n.closest('[hidden]'); };
  const panes = [...document.querySelectorAll('#splitStage .pane')];
  const fv = document.getElementById('fileView');
  const inPane = (n) => panes.findIndex((p) => n && p.contains(n));
  const f = panes[0] && panes[0].querySelector('iframe.sf-fv-page');
  const pr = panes.map((p) => p.getBoundingClientRect());
  const fr = f ? f.getBoundingClientRect() : null;
  return {
    panes: panes.length,
    panesVisible: panes.map(vis),
    stripsVisible: panes.map((p) => vis(p.querySelector('.pane-strip'))),
    fileViewPane: fv && !fv.hidden ? inPane(fv) : -1,
    fileShown: !!fv && !fv.hidden && vis(fv),
    frameInsideLeft: !!fr && !!pr[0] && fr.left >= pr[0].left - 1 && fr.right <= pr[0].right + 1 && fr.width > 100,
    leftBodyVisible: vis(panes[0] && panes[0].querySelector('.pane-body')),
    rightBodyVisible: vis(panes[1] && panes[1].querySelector('.pane-body')),
    chatVisible: vis(document.getElementById('messages')),
    leftWidth: pr[0] ? Math.round(pr[0].width) : 0,
    rightWidth: pr[1] ? Math.round(pr[1].width) : 0,
    fileTabInLeftStrip: !!(panes[0] && panes[0].querySelector('.pane-strip .sf-ftab')),
    fileTabInRightStrip: !!(panes[1] && panes[1].querySelector('.pane-strip .sf-ftab')),
  };
})()`;

type Layout = Record<string, unknown>;

Deno.test({
  name: 'a file tab in a split shows inside the first pane; both panes and both strips stay; the chat tab brings the chat back',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const lab = await Lab.open(1600, 900);
    try {
      const page: Page = lab.page;
      const dir = `${lab.fx.workspace}${SEP}outputs`;
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(`${dir}${SEP}tall.html`, '<!doctype html><h1>Tall</h1><div style="height:3000px">x</div>');
      const a = await lab.chat();
      await a.start();
      a.say('Alpha. Wrote outputs/tall.html. ALPHAEND');
      const b = await lab.chat();
      await b.start();
      b.say('Beta BETAEND');
      await lab.select(b);
      await shown(page, 'BETAEND');
      await lab.select(a);
      await shown(page, 'ALPHAEND');

      // 1-2: two chat tabs, a file opened as a third tab
      await page.eval(`AgentFilesUI.openFile(AgentFilesUI.currentScope(), 'outputs/tall.html', { keep: true })`);
      await page.waitFor(`[...document.querySelectorAll('.fx-seg button')].some((b) => b.textContent === 'Preview' && b.getClientRects().length)`, 15000, 'the file tab shows');
      await page.eval(`[...document.querySelectorAll('.fx-seg button')].find((b) => b.textContent === 'Preview').click()`);
      await page.waitFor(`[...document.querySelectorAll('iframe.sf-fv-page')].some((f) => f.getClientRects().length)`, 15000, 'the preview shows');
      assertEquals(await page.eval<string>(`AgentFilesUI._state().view`), 'file', 'a main tab, not beside');
      // the chat tab is dragged out: the chat is what shows while the drag starts
      await page.eval(`[...document.querySelectorAll('#chatTabs .ws-tab:not(.sf-ftab) .ws-tab-main')][0].click()`);
      await settle(500);

      // 3: the second chat makes a side-by-side split; the file tab stays in the left pane's strip
      await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
      await page.waitFor(`AgentSplitUI.panes().length === 2`, 15000, 'two panes').catch(async (e) => {
        throw new Error(e.message + ': ' + (await page.eval<string>(`JSON.stringify({ l: AgentSplitUI.layout(), active: AgentSplitUI.active(), w: innerWidth, main: JSON.stringify(document.querySelector('main').getBoundingClientRect()), hd: JSON.stringify((document.querySelector('main > header')||document.body).getBoundingClientRect()), view: AgentFilesUI._state().view, beside: JSON.stringify(AgentFilesUI._state().beside.tabs.length), bodyCls: document.body.className, kids: [...document.querySelector('main').children].map((c) => c.id + '.' + c.className + ':' + Math.round(c.getBoundingClientRect().width)).join(' | '), tabs: [...document.querySelectorAll('.ws-tab')].map((t) => t.textContent) })`)));
      });
      await settle(1200);
      const split = await page.eval<Layout>(LAYOUT);
      assertEquals([split.fileTabInLeftStrip, split.fileTabInRightStrip], [true, false], 'the file tab is in the left strip: ' + JSON.stringify(split));

      // 4: the file tab is clicked: the file opens inside the left pane
      await page.eval(`document.querySelector('#splitStage .pane-strip .sf-ftab .ws-tab-main').click()`);
      await settle(800);
      const on = await page.eval<Layout>(LAYOUT);
      const why = JSON.stringify(on);
      assertEquals(on.panes, 2, why);
      assertEquals(on.panesVisible, [true, true], 'both panes show: ' + why);
      assertEquals(on.stripsVisible, [true, true], 'both strips show: ' + why);
      assertEquals(on.fileViewPane, 0, 'the file view is inside the left pane: ' + why);
      assert(on.fileShown && on.frameInsideLeft, 'the preview fills the left pane only: ' + why);
      assertEquals(on.rightBodyVisible, true, 'the right pane keeps its chat: ' + why);
      assertEquals(on.leftBodyVisible, false, 'the left chat gives way to the file: ' + why);
      assert(Math.abs((on.leftWidth as number) - (split.leftWidth as number)) <= 2 && Math.abs((on.rightWidth as number) - (split.rightWidth as number)) <= 2, 'the panes keep their width: ' + why);

      // the other pane's chat tab: nothing hides, the file stays where it is
      const right = await page.eval<string>(`AgentSplitUI.panes()[1].group.active`);
      await page.eval(`AgentSplitUI.panes()[1].strip.querySelector('.ws-tab .ws-tab-main').click()`);
      await settle(800);
      const other = await page.eval<Layout>(LAYOUT);
      assert(other.fileShown && other.fileViewPane === 0 && other.rightBodyVisible && right, 'focus in the right pane leaves the file: ' + JSON.stringify(other));

      // back: the left pane's chat tab shows its chat again, the file view is gone, the file tab stays in the strip
      await page.eval(`AgentSplitUI.panes()[0].strip.querySelector('.ws-tab:not(.sf-ftab) .ws-tab-main').click()`);
      await settle(800);
      const back = await page.eval<Layout>(LAYOUT);
      const w = JSON.stringify(back);
      assertEquals(back.panesVisible, [true, true], w);
      assertEquals(back.stripsVisible, [true, true], w);
      assertEquals(back.fileShown, false, 'the file view is gone: ' + w);
      assertEquals(back.leftBodyVisible, true, 'the chat shows in the left pane: ' + w);
      assertEquals(back.fileTabInLeftStrip, true, w);

      // and the file tab again
      await page.eval(`document.querySelector('#splitStage .pane-strip .sf-ftab .ws-tab-main').click()`);
      await settle(600);
      const again = await page.eval<Layout>(LAYOUT);
      assert(again.fileShown && again.fileViewPane === 0 && (again.panesVisible as boolean[]).every(Boolean), JSON.stringify(again));

      // leaving the split (one pane) puts the file view back under the chat strip
      await page.eval(`(async () => { for (const p of AgentSplitUI.panes().slice(1)) await AgentSplitUI.closeTab(p.group.active); })()`).catch(() => {});
      assertEquals(page.errors, [], 'no console errors');
      a.end();
      b.end();
    } finally {
      await lab.close();
    }
  },
});
