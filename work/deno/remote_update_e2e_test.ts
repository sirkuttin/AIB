/**
 * Updates from remote devices (remote/update.ts), against an in-process AIB with phone access on and a real UpdateService that
 * takes itself to be a test build reading a temp test feed (tools/build.ts writeFeed). The install path runs up to the helper: the
 * launcher and quit are stubs that only record (nothing swaps or quits). A "restart" is this test: the fake Tailscale Serve answers
 * 502 for a moment (AIB away), then the context gets an UpdateService running the new version on the same data folder.
 *
 *   1. HTTP: the phone's home payload carries "ready" with the feed version; GET /api/remote/update has its notes; a device without
 *      Send is refused (403 scope) and nothing starts; Check for updates answers; a device with Send starts the install path.
 *   2. The phone page: "Update ready · <version>", the notes on tap, the confirm row, Update -> "Updating AIB on <PC>…", AIB away
 *      and back as the new version -> "Updated to <version>".
 *   3. A paired computer's page: the strip's "Update ready · <version>", its row (notes, confirm), Update -> "Updating AIB on <PC>…"
 *      (also in the offline bar), back as the new version -> the page reloads and says "Updated to <version>".
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { NAME, pairPhone } from './_remote_fixture.ts';
import { phoneCall, v2Studio } from './_remote_v2b.ts';
import { phonePage, serveFor, tap } from './_remote_phone_page.ts';
import { PLACEHOLDER_REPO, UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { HelperArgs } from '../../outputs/agent-studio/server/desktop/update_helper.ts';
import { writeFeed } from '../../tools/build.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const CURRENT = '0.1.0-beta.12.test.1', NEXT = '0.1.0-beta.12.test.2';
type Json = Record<string, unknown>;
type Studio = Awaited<ReturnType<typeof v2Studio>>;

/** The studio's updater: a desktop test build on Windows reading `feed`; install records instead of swapping and quitting. */
async function withUpdates(s: Studio) {
  const feed = await Deno.makeTempDir({ prefix: 'aib-remote-feed-' });
  const named = `${feed}/AIB-${NEXT}-windows-x64.zip`;
  Deno.writeTextFileSync(named, 'not a real AIB '.repeat(200));
  await writeFeed(`${feed}/feed`, NEXT, named, { notes: '- Remote updates from the phone.\n', commit: 'abc1234', date: '2026-11-16T10:00:00Z' });
  const launched: HelperArgs[] = [];
  const quits: unknown[] = [];
  const service = (current: string) =>
    new UpdateService(s.state, {
      current,
      feedDir: `${feed}/feed`,
      repo: PLACEHOLDER_REPO,
      key: ['windows', 'x64'],
      env: {},
      app: { desktop: true, pid: 4242, exe: 'C:\\AIB\\AIB.exe' },
      launcher: (a) => void launched.push(a),
      quit: (release) => void quits.push(release ?? false),
    });
  s.ctx.updates = service(CURRENT);
  assertEquals((await s.ctx.updates.checkFeed()).state, 'ready');
  return {
    launched,
    quits,
    /** AIB starts again as the new version on the same data folder (what the helper does after the swap). */
    restart() {
      const next = service(NEXT);
      next.cleanup();
      s.ctx.updates = next;
    },
    close: () => Deno.remove(feed, { recursive: true }).catch(() => {}),
  };
}

Deno.test({
  ...OPTS,
  name: 'remote update routes: home shows the ready feed version, notes, check, Send required, install runs the PC install path',
  async fn() {
    const s = await v2Studio();
    const u = await withUpdates(s);
    try {
      const phone = await pairPhone(s, 'Pixel 9');
      const viewer = await pairPhone(s, 'Old tablet', ['phone.read']);
      const home = await phoneCall(s, phone.token, 'GET', '/api/remote/home');
      assertEquals(home.status, 200);
      const up = home.json.update as Json;
      assertEquals([up.state, up.version, up.current, up.canInstall], ['ready', NEXT, CURRENT, true], JSON.stringify(up));
      const got = await phoneCall(s, viewer.token, 'GET', '/api/remote/update');
      assertEquals(got.status, 200);
      const notes = (got.json.update as Json).notes as Json[];
      assertEquals(notes.map((n) => [n.version, n.body]), [[NEXT, '- Remote updates from the phone.']]);
      // no Send: refused, nothing starts
      const refused = await phoneCall(s, viewer.token, 'POST', '/api/remote/update/install', {});
      assertEquals([refused.status, refused.json.code], [403, 'scope']);
      assertEquals([u.launched.length, u.quits.length], [0, 0]);
      // Check for updates: any paired device
      const check = await phoneCall(s, viewer.token, 'POST', '/api/remote/update/check', {});
      assertEquals(check.status, 200);
      for (let i = 0; i < 50 && s.ctx.updates.status().checking; i++) await new Promise((r) => setTimeout(r, 50));
      // Send: the PC's own install path (the helper with the verified file; then AIB quits)
      const go = await phoneCall(s, phone.token, 'POST', '/api/remote/update/install', { whenIdle: false });
      assertEquals([go.status, go.json.state], [200, 'installing'], JSON.stringify(go.json));
      assertEquals(u.launched.length, 1);
      assertEquals([u.launched[0].version, u.launched[0].kind, u.launched[0].sha256], [NEXT, 'windows-zip', s.ctx.updates.state.downloaded!.sha256]);
      assertEquals(u.quits.length, 1);
      // AIB comes back as the new version: the device is still paired (devices.json in the data folder) and sees it
      u.restart();
      const after = await phoneCall(s, phone.token, 'GET', '/api/remote/home');
      assertEquals(after.status, 200);
      assertEquals([(after.json.update as Json).current, (after.json.update as Json).state], [NEXT, 'none']);
    } finally {
      await u.close();
      await s.close();
    }
  },
});

const pcNameOf = (page: Page) => page.eval<string>('window.__aibPhone ? window.__aibPhone.pcName : window.AIBRemote.pcName()');

Deno.test({
  ...OPTS,
  name: 'phone page: Update ready line, notes on tap, confirm row, Updating across the restart, then Updated to the new version',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const u = await withUpdates(s);
    const browser = await Browser.launch();
    const gate = { down: false };
    try {
      const phone = await pairPhone(s, 'Pixel 9');
      const page = await phonePage(browser, s, phone, undefined, 412, false, gate);
      await page.waitFor('document.querySelector("#phUpdate")?.dataset.update === "ready"', 15000, 'the update line');
      assertEquals(await page.eval('document.getElementById("phUpdateText").textContent'), `Update ready · ${NEXT}`);
      await tap(page, '#phUpdateText');
      await page.waitFor('/Remote updates from the phone/.test(document.getElementById("phUpdateNotes")?.textContent || "")', 8000, 'notes');
      await tap(page, '#phUpdateGo');
      await page.waitFor('document.querySelector("#phUpdate")?.dataset.update === "confirm"', 5000, 'the confirm row');
      const pc = await pcNameOf(page);
      assertEquals(await page.eval('document.getElementById("phUpdateText").textContent'), `Restart AIB on ${pc} to update? Chats keep running.`);
      assertEquals(u.launched.length, 0, 'nothing before the confirm');
      await tap(page, '#phUpdateYes');
      await page.waitFor('document.querySelector("#phUpdate")?.dataset.update === "updating"', 8000, 'updating');
      assertEquals(await page.eval('document.getElementById("phUpdateText").textContent'), `Updating AIB on ${pc}…`);
      assertEquals([u.launched.length, u.quits.length], [1, 1], 'the install path ran');
      // AIB away (Serve answers 502), then back as the new version
      gate.down = true;
      await page.waitFor('window.__aibPhone.offline === true', 30000, 'the phone sees AIB away');
      assertEquals(await page.eval('document.querySelector("#phUpdate")?.dataset.update'), 'updating', 'still "Updating", not "Can\'t reach"');
      assertEquals(await page.eval('document.querySelectorAll(".ph-offline").length'), 0);
      u.restart();
      gate.down = false;
      await page.waitFor('document.querySelector("#phUpdate")?.dataset.update === "done"', 60000, 'back by itself');
      assertEquals(await page.eval('document.getElementById("phUpdateText").textContent'), `Updated to ${NEXT}`);
      await page.shot('remote-update-phone-done');
      // the "late" words, from the same rules (no 2-minute wait in a test)
      const late = await page.eval<Json>(
        `AIBPhone.updateView({phase:'updating', at: Date.now() - AIBPhone.UPDATE_LATE_MS - 1}, null, 'Studio PC', {send:true}, Date.now())`,
      );
      assertEquals(late.kind, 'late');
      assertEquals(late.text, 'AIB hasn’t come back yet on Studio PC.');
    } finally {
      await browser.close();
      await u.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'computer page: Update ready in the strip, row with notes and confirm, Updating across the restart, reload, Updated to',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const u = await withUpdates(s);
    const browser = await Browser.launch();
    const gate = { down: false };
    try {
      const computer = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const page = await browser.open('about:blank', 1280, 860);
      await serveFor(page, s, gate);
      await page.goto(`https://${NAME}/remote.css`);
      await page.eval(`new Promise((resolve, reject) => {
        const req = indexedDB.open('aib-phone', 2);
        req.onupgradeneeded = () => { req.result.createObjectStore('kv'); req.result.createObjectStore('chats', { keyPath: 'key' }); };
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ token: ${JSON.stringify(computer.token)}, device: { id: ${JSON.stringify(computer.id)} } }, 'device');
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      })`);
      await page.goto(`https://${NAME}/`);
      await page.waitFor('location.pathname === "/pc.html"', 15000, 'the computer page');
      await page.waitFor('document.getElementById("updateButton")?.dataset.update === "ready"', 20000, 'the strip line');
      assertEquals(await page.eval('document.getElementById("updateButton").textContent'), `Update ready · ${NEXT}`);
      await page.eval('document.getElementById("updateButton").click()');
      await page.waitFor('/Remote updates from the phone/.test(document.getElementById("updateRemoteNotes")?.textContent || "")', 8000, 'notes');
      await page.eval('document.getElementById("updateRemoteGo").click()');
      await page.waitFor('!!document.getElementById("updateRemoteYes")', 5000, 'the confirm row');
      const pc = await pcNameOf(page);
      assert(
        String(await page.eval('document.getElementById("updatePopover").textContent')).includes(`Restart AIB on ${pc} to update? Chats keep running.`),
        'the confirm words',
      );
      assertEquals(u.launched.length, 0, 'nothing before the confirm');
      await page.eval('document.getElementById("updateRemoteYes").click()');
      await page.waitFor('document.getElementById("updateButton")?.dataset.update === "updating"', 8000, 'updating');
      assertEquals(await page.eval('document.getElementById("updateButton").textContent'), `Updating AIB on ${pc}…`);
      assertEquals([u.launched.length, u.quits.length], [1, 1], 'the install path ran');
      gate.down = true;
      await page.waitFor('/Updating AIB on/.test(document.getElementById("remoteOffline")?.textContent || "")', 30000, 'the offline bar says Updating');
      u.restart();
      gate.down = false;
      await page.waitFor(
        'document.getElementById("updateButton")?.dataset.update === "done" && performance.getEntriesByType("navigation")[0]?.type === "reload"',
        60000,
        'back, reloaded',
      );
      assertEquals(await page.eval('document.getElementById("updateButton").textContent'), `Updated to ${NEXT}`);
      const box = await page.eval<Json>(
        '(function(){var b=document.getElementById("updateButton"),r=b.getBoundingClientRect();return {w:r.width,h:r.height,hidden:b.hidden,parent:b.parentNode&&b.parentNode.id,x:r.left,y:r.top}})()',
      );
      assert(Number(box.w) > 0 && Number(box.h) > 0 && box.parent === 'chatTabs', `the line is on screen in the strip: ${JSON.stringify(box)}`);
      await page.shot('remote-update-pc-done');
    } finally {
      await browser.close();
      await u.close();
      await s.close();
    }
  },
});
