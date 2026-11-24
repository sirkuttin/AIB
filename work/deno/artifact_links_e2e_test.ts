/**
 * Links to artifacts, end to end (owner, 2026-11-17):
 *   - A link inside an artifact page to another artifact (studio-artifact://<id>) opens that artifact in the viewer. The page stays
 *     sandboxed; its injected script (origin.ts SCROLL_SCRIPT) asks AIB by postMessage, and AIB takes the ask only from the frame
 *     showing the artifact, only for an artifact that exists.
 *   - A path link in a reply to a file that is a published artifact opens the artifact (not the file's Source view).
 *   - A path link to an HTML file that is no artifact opens the file on Preview, not Source.
 *
 * A real AIB (Deno web server + in-process agent host, temp state folder and workspace, free port; never the live ports), the
 * scripted agent work/scroll-fixture/agent.mjs, and a headless Chrome/Edge on chat.html (no window).
 *
 * Run (from app): deno test -A ../../work/deno/artifact_links_e2e_test.ts
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, type Page, settle, shown } from './_scroll_lab.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const OPTIONS = { ignore: !browserPath, sanitizeResources: false, sanitizeOps: false };

async function publish(lab: Lab, chat: Chat, name: string, title: string, html: string): Promise<string> {
  const dir = `${lab.fx.workspace}${SEP}outputs`;
  Deno.mkdirSync(dir, { recursive: true });
  const path = `${dir}${SEP}${name}`;
  Deno.writeTextFileSync(path, html);
  const [status, made] = await lab.web.post('artifacts/publish', { conversationId: chat.id, path, title });
  assert(status === 200, `artifacts/publish: ${status} ${JSON.stringify(made)}`);
  return String(made.id);
}

const selected = (page: Page) => page.eval<string>(`ArtifactsUI.state().selId || ''`);

/** A real mouse click at (dx, dy) inside the artifact frame (a cross-origin, sandboxed page: no selector reaches into it). */
async function clickInFrame(page: Page, dx: number, dy: number): Promise<void> {
  const at = await page.eval<[number, number] | string>(`(() => {
    const f = [...document.querySelectorAll('#artifactsPane iframe.ar-frame')].find((x) => !x.classList.contains('loading'));
    if (!f) return 'no frame';
    const r = f.getBoundingClientRect();
    return r.width > 40 && r.height > 40 ? [r.left + ${dx}, r.top + ${dy}] : 'frame not shown';
  })()`);
  if (typeof at === 'string') throw new Error(at);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
  }
}

/** A page whose top-left 200 x 120 px is one link to `href`. */
const linkPage = (title: string, href: string) =>
  `<!doctype html><html><body style="margin:0"><a id="go" href="${href}" style="position:fixed;left:0;top:0;width:200px;height:120px;display:block;background:#cde">${title}</a></body></html>`;

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
  name: 'a link in an artifact to another artifact opens it; a missing id or an ask from outside the frame opens nothing',
  ...OPTIONS,
  async fn() {
    const { lab, chat } = await started();
    try {
      const page = lab.page;
      const target = await publish(lab, chat, 'target.html', 'Target page', '<!doctype html><h1>Target</h1>');
      const missing = 'ab'.repeat(8);
      const source = await publish(lab, chat, 'source.html', 'Source page', linkPage('Go to target', `studio-artifact://${target}`));
      const broken = await publish(lab, chat, 'broken.html', 'Broken link', linkPage('Go nowhere', `studio-artifact://${missing}`));
      await page.click('#paneTab-artifacts');
      await page.waitFor(`ArtifactsUI.state().list.length >= 3`, 15000, 'three artifacts');

      // an ask that does not come from the artifact's frame is ignored
      await page.eval(`ArtifactsUI.open(${JSON.stringify(source)})`);
      await page.waitFor(`!!document.querySelector('#artifactsPane iframe.ar-frame:not(.loading)')`, 15000, 'the source page');
      await settle(800); // the page has loaded and its script runs
      await page.eval(`window.postMessage({ type: 'studio-artifact-open', id: ${JSON.stringify(target)} }, '*')`);
      await settle(600);
      assertEquals(await selected(page), source, 'the page window itself cannot open an artifact');

      // the link in the page: the target artifact opens in the viewer
      await clickInFrame(page, 40, 40);
      await page.waitFor(`ArtifactsUI.state().selId === ${JSON.stringify(target)}`, 10000, 'the target artifact opened from the link');
      const sandbox = await page.eval<string>(`document.querySelector('#artifactsPane iframe.ar-frame:not(.loading)').getAttribute('sandbox') || ''`);
      assert(sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'), `the page keeps its sandbox: ${sandbox}`);

      // a link to an artifact that does not exist: nothing opens, AIB says so
      await page.eval(`ArtifactsUI.open(${JSON.stringify(broken)})`);
      await page.waitFor(`ArtifactsUI.state().selId === ${JSON.stringify(broken)} && !!document.querySelector('#artifactsPane iframe.ar-frame:not(.loading)')`, 15000, 'the broken page');
      await settle(800);
      await clickInFrame(page, 40, 40);
      await page.waitFor(`/no longer in AIB/.test(document.getElementById('artifactsPane').innerText)`, 10000, 'the note that it is gone');
      assertEquals(await selected(page), broken, 'still on the page with the broken link');
      chat.end();
    } finally {
      await lab.close();
    }
  },
});

Deno.test({
  name: 'a path link in a reply to a published artifact opens the artifact; to a plain HTML file, the file on Preview',
  ...OPTIONS,
  async fn() {
    const { lab, chat } = await started();
    const cleanup: string[] = [];
    try {
      const page = lab.page;
      const id = await publish(lab, chat, 'report.html', 'Weekly report', '<!doctype html><h1>Report</h1>');
      Deno.writeTextFileSync(`${lab.fx.workspace}${SEP}outputs${SEP}plain.html`, '<!doctype html><h1>Plain</h1>');
      chat.say('Wrote outputs/report.html and outputs/plain.html. LINKSREADY');
      await shown(page, 'LINKSREADY');
      const link = (rel: string) => `#messages a.fx-path[data-file-path="${rel}"]`;
      await page.waitFor(`!!document.querySelector('${link('outputs/report.html')}') && !!document.querySelector('${link('outputs/plain.html')}')`, 20000, 'the path links');

      // the artifact's file: the artifact opens in the Artifacts tab, no Source view of the file
      await page.click(link('outputs/report.html'));
      await page.waitFor(`ArtifactsUI.state().selId === ${JSON.stringify(id)}`, 10000, 'the artifact opened');
      await page.waitFor(`!!document.querySelector('#artifactsPane iframe.ar-frame')`, 10000, 'its page shows');
      await settle(300);
      assert(
        !(await page.eval<boolean>(`[...document.querySelectorAll('.sf-fv-crumb b')].some((b) => b.textContent === 'report.html' && b.getClientRects().length)`)),
        'the file view did not open the file',
      );

      // a plain HTML file: the file view on Preview (Source is one click away)
      await page.click(link('outputs/plain.html'));
      await page.waitFor(`[...document.querySelectorAll('iframe.sf-fv-page')].some((f) => f.getClientRects().length && /plain\\.html/.test(f.title))`, 15000, 'the Preview of plain.html');
      const pressed = await page.eval<string>(`[...document.querySelectorAll('.fx-seg button[aria-pressed="true"]')].filter((b) => b.getClientRects().length).map((b) => b.textContent).join(',')`);
      assertEquals(pressed, 'Preview');

      // the same by full path: the artifact's file inside the project, and an HTML file outside it (opens read only, on Preview)
      const outDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-art-links-' }));
      cleanup.push(outDir);
      const outside = `${outDir}${SEP}outside.html`;
      Deno.writeTextFileSync(outside, '<!doctype html><h1>Outside</h1>');
      const full = `${lab.fx.workspace}${SEP}outputs${SEP}report.html`;
      await page.eval(`ArtifactsUI.open(${JSON.stringify(await publish(lab, chat, 'other.html', 'Other', '<h1>Other</h1>'))})`);
      chat.say(`\n\nFull paths: ${full} and ${outside} FULLREADY`);
      await shown(page, 'FULLREADY');
      const byAbs = (abs: string) => `[...document.querySelectorAll('#messages a.fx-path')].find((a) => (a.dataset.abs || '').toLowerCase() === ${JSON.stringify(abs.toLowerCase())})`;
      await page.waitFor(`!!${byAbs(full)} && !!${byAbs(outside)}`, 20000, 'the full-path links');
      await page.eval(`${byAbs(full)}.click()`);
      await page.waitFor(`ArtifactsUI.state().selId === ${JSON.stringify(id)}`, 10000, 'the artifact opened from its full path');
      await page.eval(`${byAbs(outside)}.click()`);
      await page.waitFor(`[...document.querySelectorAll('iframe.sf-fv-page')].some((f) => f.getClientRects().length && /outside\\.html/.test(f.title))`, 15000, 'the Preview of the outside file');

      // an artifact of a chat in another folder (no list the page loads holds it): AIB's server finds it by its file, and it opens
      const farDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-art-far-' }));
      cleanup.push(farDir);
      const [cs, conn] = await lab.web.post('connect', { provider: 'claude', cwd: farDir, background: true });
      assert(cs === 200, `connect: ${cs} ${JSON.stringify(conn)}`);
      const farChat = String(conn.id);
      for (let i = 0; i < 300 && !(await lab.web.state(farChat)).sessionId; i++) await settle(100);
      const far = `${farDir}${SEP}far.html`;
      Deno.writeTextFileSync(far, '<!doctype html><h1>Far</h1>');
      const [ps, made] = await lab.web.post('artifacts/publish', { conversationId: farChat, path: far, title: 'Far page' });
      assert(ps === 200, `publish: ${ps} ${JSON.stringify(made)}`);
      const [bs, by] = await lab.web.get(`/api/live/artifacts/by-source?paths=${encodeURIComponent(JSON.stringify([Deno.build.os === 'windows' ? far.toUpperCase() : far]))}`);
      assertEquals([bs, (by.artifact as Record<string, unknown> | null)?.id], [200, made.id], 'the route finds it (Windows: any case; elsewhere paths are case-sensitive, so the same case)');
      chat.say(`\n\nThe other chat made ${far} FARREADY`);
      await shown(page, 'FARREADY');
      await page.waitFor(`!!${byAbs(far)}`, 20000, 'the far link');
      await page.eval(`${byAbs(far)}.click()`);
      await page.waitFor(`ArtifactsUI.state().selId === ${JSON.stringify(made.id)}`, 10000, "the other chat's artifact opened");
      assertEquals(page.errors, [], 'no console errors');
      chat.end();
    } finally {
      await lab.close();
      for (const d of cleanup) {
        try {
          Deno.removeSync(d, { recursive: true });
        } catch { /* gone */ }
      }
    }
  },
});
