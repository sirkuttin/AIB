/**
 * A page Preview stays put while a chat runs (owner, 2026-11-17: "every so often just flashes and resets to the top").
 * The Files view redrew the whole file view on every redraw (a project artifact list that came in again, a change badge, a poll),
 * built a new iframe with the same address, and the page loaded again at the top. Now the Preview's iframe node stays where it is
 * across redraws, and it loads again only when the file changed on disk, then at the scroll the reader was at.
 * The Artifacts viewer is held to the same: unrelated redraws never load its frame again; a new version does, at the same scroll.
 *
 * A real Studio (temp state folder and workspace, free port; never the live ports), the scripted agent, and a headless Chrome/Edge.
 * Run (from app): deno test -A ../../work/deno/preview_keeps_scroll_e2e_test.ts
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, type Page, settle, shown } from './_scroll_lab.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const OPTIONS = { ignore: !browserPath, sanitizeResources: false, sanitizeOps: false };

const tall = (title: string, extra = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body style="margin:0"><h1>${title}</h1>${extra}<div style="height:6000px;background:linear-gradient(#fff,#abc)">tall</div></body></html>`;

/** Every scroll report a page's injected script sends (origin.ts SCROLL_SCRIPT), per frame window, kept on the test's window. */
const LISTEN = `(() => {
  window.__scrolls = [];
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'studio-artifact-scroll') window.__scrolls.push({ y: e.data.y, src: window.__frameOf ? window.__frameOf(e.source) : '' });
  });
})()`;

/** Mark the shown frame (matching `sel`) so a later check can tell it is the same node, and count its load events. */
async function mark(page: Page, sel: string): Promise<void> {
  await page.eval(`(() => {
    const f = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length && !x.classList.contains('loading'));
    if (!f) throw new Error('no frame ' + ${JSON.stringify(sel)});
    window.__mark = f;
    window.__loads = 0;
    f.addEventListener('load', () => window.__loads++);
    window.__frameOf = (w) => (w === f.contentWindow ? 'mark' : '');
  })()`);
}

const unchanged = (page: Page, sel: string) =>
  page.eval<{ same: boolean; connected: boolean; loads: number; shown: boolean }>(`(() => {
    const f = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length && !x.classList.contains('loading'));
    return { same: f === window.__mark, connected: !!window.__mark && window.__mark.isConnected, loads: window.__loads, shown: !!f };
  })()`);

const lastY = (page: Page) => page.eval<number>(`(() => { const a = window.__scrolls.filter((s) => s.src === 'mark'); return a.length ? a[a.length - 1].y : -1; })()`);

/** Wheel over the frame's centre: the page scrolls itself and reports where it is. */
async function wheelFrame(page: Page, sel: string, dy: number): Promise<void> {
  const [x, y] = await page.eval<[number, number]>(
    `(() => { const f = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length); const r = f.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  await settle(300);
}

async function started(): Promise<{ lab: Lab; chat: Chat }> {
  const lab = await Lab.open(1600, 900);
  const chat = await lab.chat();
  await chat.start();
  chat.say('Hello READY');
  await lab.select(chat);
  await shown(lab.page, 'READY');
  return { lab, chat };
}

Deno.test({
  name: 'an HTML Preview in a Files tab keeps its iframe, its load and its scroll across redraws; a changed file loads again at the same scroll',
  ...OPTIONS,
  async fn() {
    const { lab, chat } = await started();
    try {
      const page = lab.page;
      const SEL = 'iframe.sf-fv-page';
      const dir = `${lab.fx.workspace}${SEP}outputs`;
      Deno.mkdirSync(dir, { recursive: true });
      const file = `${dir}${SEP}tall.html`;
      Deno.writeTextFileSync(file, tall('First'));
      chat.say('Wrote outputs/tall.html. PREVIEWREADY');
      await shown(page, 'PREVIEWREADY');
      const link = `#messages a.fx-path[data-file-path="outputs/tall.html"]`;
      await page.waitFor(`!!document.querySelector('${link}')`, 20000, 'the path link');
      await page.click(link);
      await page.waitFor(`[...document.querySelectorAll('${SEL}')].some((f) => f.getClientRects().length)`, 15000, 'the Preview');
      await page.eval(LISTEN);
      await mark(page, SEL);
      await settle(1500); // the page loaded and its script runs
      await page.eval(`window.__loads = 0`); // loads that were still coming in when the frame was marked do not count
      await wheelFrame(page, SEL, 700);
      const y0 = await lastY(page);
      assert(y0 > 300, `the page scrolled down: ${y0}`);

      // The redraws a running chat causes: the project's artifact lists coming in again, a redraw of the open file view (a change badge
      // or file info), the Files panel painting, a poll of local files, and the chat's own streaming.
      for (let i = 0; i < 3; i++) {
        await page.eval(`AgentFilesUI._refreshArtifacts()`);
        await page.eval(`AgentFilesUI._redraw()`);
        await page.eval(`AgentFilesUI.paint()`);
        await page.eval(`AgentFilesUI._reloadLocalTabs()`);
        chat.say(`Still working, step ${i}. `);
        await settle(500);
      }
      const same = await unchanged(page, SEL);
      assertEquals(same, { same: true, connected: true, loads: 0, shown: true }, 'the same iframe node, no load event');
      assertEquals(await lastY(page), y0, 'the scroll did not move');

      // The file changes on disk: it loads again (a redraw looks at the file, at most every 3 s) and opens at the same scroll.
      Deno.writeTextFileSync(file, tall('Second', '<p>one more line</p>'));
      await settle(3300);
      await page.eval(`AgentFilesUI._redraw()`);
      await page.waitFor(
        `(() => { const f = [...document.querySelectorAll('${SEL}')].find((x) => x.getClientRects().length); return !!f && f !== window.__mark; })()`,
        15000,
        'the Preview loads again after the file changed',
      );
      await mark(page, SEL);
      await page.eval(`window.__scrolls = []`);
      await settle(1200);
      await wheelFrame(page, SEL, 1); // a tiny wheel makes the page report where it stands
      const y1 = await lastY(page);
      assert(Math.abs(y1 - y0) <= 4, `the reloaded page is at the old scroll: ${y1} vs ${y0}`);
      // and it stays put again
      await page.eval(`window.__loads = 0`);
      await page.eval(`AgentFilesUI._redraw()`);
      await settle(400);
      assertEquals((await unchanged(page, SEL)).same, true);
      assertEquals((await unchanged(page, SEL)).loads, 0);

      // Source and back: the toggle is a real change of what shows, the page opens again at the scroll it had.
      await page.eval(`[...document.querySelectorAll('.fx-seg button')].find((b) => b.textContent === 'Source').click()`);
      await page.waitFor(`!document.querySelector('${SEL}')`, 5000, 'Source shows');
      await page.eval(`[...document.querySelectorAll('.fx-seg button')].find((b) => b.textContent === 'Preview').click()`);
      await page.waitFor(`!!document.querySelector('${SEL}')`, 5000, 'Preview shows');
      assertEquals(page.errors, [], 'no console errors');
      chat.end();
    } finally {
      await lab.close();
    }
  },
});

Deno.test({
  name: 'the Artifacts viewer keeps its frame across unrelated redraws; a new version loads again at the same scroll',
  ...OPTIONS,
  async fn() {
    const { lab, chat } = await started();
    try {
      const page = lab.page;
      const SEL = '#artifactsPane iframe.ar-frame';
      const dir = `${lab.fx.workspace}${SEP}outputs`;
      Deno.mkdirSync(dir, { recursive: true });
      const path = `${dir}${SEP}art.html`;
      Deno.writeTextFileSync(path, tall('Art one'));
      const [status, made] = await lab.web.post('artifacts/publish', { conversationId: chat.id, path, title: 'Art' });
      assert(status === 200, `publish: ${status} ${JSON.stringify(made)}`);
      await page.click('#paneTab-artifacts');
      await page.waitFor(`ArtifactsUI.state().list.length >= 1`, 15000, 'the artifact');
      await page.eval(`ArtifactsUI.open(${JSON.stringify(String(made.id))})`);
      await page.waitFor(`!!document.querySelector('${SEL}:not(.loading)')`, 15000, 'the page');
      await page.eval(LISTEN);
      await mark(page, SEL);
      await settle(1500);
      await page.eval(`window.__loads = 0`);
      await wheelFrame(page, SEL, 700);
      const y0 = await lastY(page);
      assert(y0 > 300, `the page scrolled down: ${y0}`);

      for (let i = 0; i < 3; i++) {
        await page.eval(`ArtifactsUI.shown()`);
        await page.eval(`ArtifactsUI.setVisible(false)`);
        await page.eval(`ArtifactsUI.setVisible(true)`);
        chat.say(`Still working, step ${i}. `);
        await settle(600);
      }
      assertEquals(await unchanged(page, SEL), { same: true, connected: true, loads: 0, shown: true }, 'the same frame, no load event');
      assertEquals(await lastY(page), y0, 'the scroll did not move');

      // a new version: the page loads again, at the scroll the reader was at
      Deno.writeTextFileSync(path, tall('Art two', '<p>one more line</p>'));
      const [s2, again] = await lab.web.post('artifacts/publish', { conversationId: chat.id, path, title: 'Art' });
      assert(s2 === 200, `publish again: ${s2} ${JSON.stringify(again)}`);
      await page.waitFor(
        `(() => { const f = [...document.querySelectorAll('${SEL}')].find((x) => x.getClientRects().length && !x.classList.contains('loading')); return !!f && f !== window.__mark; })()`,
        20000,
        'the new version loads',
      );
      await mark(page, SEL);
      await page.eval(`window.__scrolls = []`);
      await settle(1200);
      await wheelFrame(page, SEL, 1);
      const y1 = await lastY(page);
      assert(Math.abs(y1 - y0) <= 4, `the new version is at the old scroll: ${y1} vs ${y0}`);
      chat.end();
    } finally {
      await lab.close();
    }
  },
});

Deno.test({
  name: 'a long run: an open artifact and an open file Preview are never built or loaded again while a chat works for over two minutes',
  ...OPTIONS,
  async fn() {
    const { lab, chat } = await started();
    try {
      const page = lab.page;
      const dir = `${lab.fx.workspace}${SEP}outputs`;
      Deno.mkdirSync(dir, { recursive: true });
      const path = `${dir}${SEP}long.html`;
      Deno.writeTextFileSync(path, tall('Long'));
      Deno.writeTextFileSync(`${dir}${SEP}plain.html`, tall('Plain'));
      const [status, made] = await lab.web.post('artifacts/publish', { conversationId: chat.id, path, title: 'Long' });
      assert(status === 200, `publish: ${status} ${JSON.stringify(made)}`);
      await page.click('#paneTab-artifacts');
      await page.waitFor(`ArtifactsUI.state().list.length >= 1`, 15000, 'the artifact');
      await page.eval(`ArtifactsUI.open(${JSON.stringify(String(made.id))})`);
      const ART = '#artifactsPane iframe.ar-frame';
      await page.waitFor(`!!document.querySelector('${ART}:not(.loading)')`, 15000, 'the page');
      // a file Preview beside the chat as well
      await page.eval(`AgentFilesUI.openFile(AgentFilesUI.currentScope(), 'outputs/plain.html', { keep: true, beside: true })`);
      await page.waitFor(`[...document.querySelectorAll('.fx-seg button')].some((b) => b.textContent === 'Preview' && b.getClientRects().length)`, 15000, 'the file shows');
      await page.eval(`[...document.querySelectorAll('.fx-seg button')].find((b) => b.textContent === 'Preview').click()`);
      await page.waitFor(`!!document.querySelector('iframe.sf-fv-page')`, 15000, 'the Preview');
      await page.eval(LISTEN);
      await mark(page, ART);
      await settle(2000);
      // every iframe that comes into or goes out of the page, from here on
      await page.eval(`(() => {
        window.__loads = 0;
        window.__frames = [];
        new MutationObserver((ms) => { for (const m of ms) for (const n of [...m.addedNodes, ...m.removedNodes]) if (n.nodeName === 'IFRAME') window.__frames.push((m.addedNodes.length ? 'add ' : 'del ') + n.className); })
          .observe(document.body, { childList: true, subtree: true });
      })()`);
      await wheelFrame(page, ART, 700);
      const y0 = await lastY(page);
      assert(y0 > 300, `the artifact scrolled: ${y0}`);
      // 2 min 15 s of a working chat: messages and tool calls; the artifact list polls every 3 s, the file view redraws on its timers
      const end = Date.now() + 135_000;
      for (let i = 0; Date.now() < end; i++) {
        chat.say(`Working, step ${i}. `);
        chat.tool(`t${i}`, `Edit file ${i}`, 'completed');
        await settle(4000);
        const frames = await page.eval<string[]>('window.__frames');
        assertEquals(frames, [], `an iframe was built or dropped at step ${i}`);
      }
      assertEquals(await unchanged(page, ART), { same: true, connected: true, loads: 0, shown: true }, 'the same artifact frame after two minutes, no load');
      assertEquals(await lastY(page), y0, 'the artifact did not move');
      chat.end();
    } finally {
      await lab.close();
    }
  },
});
