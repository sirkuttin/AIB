/**
 * The Update button and "What's new in AIB <version>", end to end: a real Studio server (source run, own temp data folder, a port the
 * OS picked) and headless Chrome/Edge; a local fake GitHub releases API (AIB_UPDATE_API_BASE) serves several releases with notes.
 * No real update runs: the version change is the updater's test hook AIB_UPDATE_CURRENT (honoured only with a fake release server).
 *
 *   1. The server takes itself to be an older version (AIB_UPDATE_CURRENT) and checks: the newest release (APP_VERSION) is
 *      downloaded and verified. The page shows the teal Update button at the right end of the tab strip, with the version in its
 *      tooltip, and no amber line. No notes tab yet (that version is not running).
 *   2. Started again on the same data folder as APP_VERSION (what the update helper does after the swap): the page opens one
 *      read-only "What's new in AIB <APP_VERSION>" tab listing every release's notes, newest first (the installed version on top),
 *      each with its version heading and date. The Update button is gone (the update is installed).
 *   3. A reload does not open the tab again, and the server no longer offers the notes.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, SEP, TEST_OPTIONS } from './_host_fixture.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { APP_VERSION } from '../../outputs/agent-studio/server/core/app.ts';
import { compare, parseVersion } from '../../outputs/agent-studio/server/desktop/updater.ts';

/** The version before APP_VERSION in the fake list, and the one before that (0.1.0-beta.8 -> beta.7, beta.6). */
function older(version: string, by: number): string {
  const p = parseVersion(version)!;
  const pre = p[3];
  const n = Number(pre[pre.length - 1]);
  assert(pre.length && Number.isInteger(n) && n > by, `APP_VERSION ${version} is a numbered pre-release`);
  return `${p[0]}.${p[1]}.${p[2]}-${[...pre.slice(0, -1), String(n - by)].join('.')}`;
}
const OLD = older(APP_VERSION, 1), OLDER = older(APP_VERSION, 2);

async function sha(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fake GitHub: the release list (newest first, a draft, notes with Markdown) and APP_VERSION's installer + SHA256SUMS. */
async function fakeReleases(): Promise<{ base: string; requests: string[]; close: () => Promise<void> }> {
  const payload = new TextEncoder().encode('not a real AIB'.repeat(100));
  const names = ['windows-x64.zip', 'windows-arm64.zip', 'macos-x64.zip', 'macos-arm64.zip', 'linux-x64.AppImage', 'linux-arm64.AppImage']
    .map((s) => `AIB-${APP_VERSION}-${s}`);
  const hash = await sha(payload);
  const sums = names.map((n) => `${hash}  ${n}\n`).join('');
  const requests: string[] = [];
  let base = '';
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    requests.push(url.pathname);
    if (url.pathname.endsWith('/releases')) {
      const assets = names.map((name, i) => ({ name, state: 'uploaded', size: payload.length, url: `${base}/assets/${i}` }))
        .concat([{ name: 'SHA256SUMS', state: 'uploaded', size: sums.length, url: `${base}/assets/sums` }]);
      const rel = (version: string, body: string, date: string, extra: Record<string, unknown> = {}) => ({
        tag_name: 'v' + version,
        draft: false,
        prerelease: version.includes('-'),
        html_url: 'https://example.invalid/' + version,
        published_at: date,
        body,
        assets: [],
        ...extra,
      });
      return Response.json([
        rel(APP_VERSION, '## The Update button\n\n- **Update** sits at the top right of the window.', '2026-11-12T10:00:00Z', { assets }),
        rel(older(APP_VERSION, 0) + '.1', 'A draft nobody should see.', '2026-11-13T10:00:00Z', { draft: true }),
        rel(OLD, 'Files tab fixes.', '2026-11-05T10:00:00Z'),
        rel(OLDER, 'The keeper keeps chats running.', '2026-10-29T10:00:00Z'),
      ]);
    }
    if (url.pathname === '/assets/sums') return new Response(sums, { headers: { 'Content-Type': 'application/octet-stream' } });
    if (url.pathname.startsWith('/assets/')) {
      return new Response(payload as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    return new Response('no', { status: 404 });
  });
  base = `http://127.0.0.1:${server.addr.port}`;
  return { base, requests, close: () => server.shutdown() };
}

Deno.test({
  name: 'Update button, then after the version changes one "What\'s new in AIB <version>" tab with every release, newest first',
  ignore: !browserPath,
  ...TEST_OPTIONS,
  async fn() {
    assert(compare(OLD, APP_VERSION) < 0 && compare(OLDER, OLD) < 0);
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 8 minutes')), 8 * 60_000);
    });
    await using fx = new Fixture();
    const fake = await fakeReleases();
    let browser: Browser | undefined;
    try {
      await Promise.race([deadline, run(fx, fake.base, (b) => (browser = b))]);
      assert(fake.requests.some((p) => p.endsWith('/releases')), 'the fake release API was asked');
    } finally {
      clearTimeout(giveUp);
      await browser?.close();
      await fake.close();
    }
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(fx: Fixture, base: string, keep: (b: Browser) => void): Promise<void> {
  const r = fx.root;
  for (const d of ['appdata', 'localappdata', 'home']) Deno.mkdirSync(`${r}${SEP}${d}`, { recursive: true });
  const home = `${r}${SEP}home`;
  const env = (extra: Record<string, string>) => ({
    USERPROFILE: home,
    HOME: home,
    APPDATA: `${r}${SEP}appdata`,
    LOCALAPPDATA: `${r}${SEP}localappdata`,
    CODEX_HOME: `${home}${SEP}.codex`,
    ...extra,
  });
  // ---- 1. an older version finds APP_VERSION: the Update button ---------------------------------------------------------------
  let web = await fx.startWeb(['--in-process', '--no-auto-reconnect'], {
    env: env({ AIB_UPDATE_API_BASE: base, AIB_UPDATE_CURRENT: OLD }),
  });
  const browser = await Browser.launch();
  keep(browser);
  try {
    const [cs] = await web.post('update/check', {});
    assertEquals(cs, 200);
    let st: Record<string, unknown> = {};
    for (const until = Date.now() + 60_000; Date.now() < until;) {
      st = (await web.get('/api/live/update'))[1] as Record<string, unknown>;
      if (st.state === 'ready' || st.state === 'refused' || st.state === 'error') break;
      await sleep(250);
    }
    assertEquals(st.state, 'ready', JSON.stringify(st));
    assertEquals(st.current, OLD);
    assertEquals((st.available as Record<string, unknown>).version, APP_VERSION);
    assertEquals((await web.get('/api/live/update/notes'))[1], { notes: null }, 'no notes while the old version runs');

    const page = await browser.open(`http://127.0.0.1:${web.port}/`, 1600, 900);
    await page.waitFor(`(function(){var b=document.getElementById('updateButton');return !!b&&!b.hidden})()`, 30_000, 'the Update button');
    const btn = await page.eval<{ text: string; title: string; parent: string; last: boolean; right: number; top: number; vw: number }>(
      `(function(){var b=document.getElementById('updateButton'),r=b.getBoundingClientRect();return {text:b.textContent,title:b.title,parent:b.parentNode.id,last:b.parentNode.lastChild===b,right:r.right,top:r.top,vw:innerWidth}})()`,
    );
    assertEquals(btn.text, 'Update');
    // a source run cannot update itself, so the tooltip offers the how-to (the in-place wording is in test_update_button.js)
    assertEquals(btn.title, `AIB ${APP_VERSION} is downloaded and verified. This copy of AIB cannot install it by itself: click for how.`);
    assertEquals([btn.parent, btn.last], ['chatTabs', true], 'the right end of the tab strip');
    assert(btn.vw - btn.right <= 24 && btn.top <= 12, `at the window's top right: ${JSON.stringify(btn)}`);
    assertEquals(await page.eval<number>(`document.querySelectorAll('#updateBanner, .update-banner').length`), 0, 'no amber line');
    assertEquals(await page.eval<number>(`document.querySelectorAll('.sf-notestab').length`), 0, 'no notes tab yet');
    // A source run cannot install in place: the click shows the instructions in the page, nothing is installed.
    await page.eval(`document.getElementById('updateButton').click()`);
    await page.waitFor(`!!document.getElementById('updatePopover')`, 10_000, 'the instructions popover');
    assert(
      (await page.eval<string>(`document.getElementById('updatePopover').textContent`)).includes('is downloaded and verified'),
      'the popover says how',
    );
    assertEquals((await web.get('/api/live/update'))[1].state, 'ready', 'still only offered');
    await page.close();
  } finally {
    await web.kill();
  }

  // ---- 2. the same data folder, now running APP_VERSION: the notes tab, once ------------------------------------------------------
  web = await fx.startWeb(['--in-process', '--no-auto-reconnect'], { env: env({ AIB_UPDATE_API_BASE: 'http://127.0.0.1:9' }) });
  try {
    const st = (await web.get('/api/live/update'))[1] as Record<string, unknown>;
    assertEquals(st.current, APP_VERSION);
    const page = await browser.open(`http://127.0.0.1:${web.port}/`, 1600, 900);
    const title = `What's new in AIB ${APP_VERSION}`;
    await page.waitFor(
      `Array.from(document.querySelectorAll('#chatTabs .ws-tab-title')).some(function(n){return n.textContent===${JSON.stringify(title)}})`,
      30_000,
      'the notes tab',
    );
    const view = await page.eval<
      { versions: string[]; metas: string[]; h: number; strong: number; ro: boolean; on: boolean; active: boolean; scroll: string }
    >(
      `(function(){var v=document.getElementById('fileView');var s=Array.from(v.querySelectorAll('.sf-note-rel'));return {
        versions:s.map(function(x){return x.querySelector('.sf-note-ver').textContent}),
        metas:s.map(function(x){return x.querySelector('.sf-note-meta').textContent}),
        h:s[0].querySelectorAll('h3,h4,h5,h6').length, strong:s[0].querySelectorAll('strong').length,
        ro:/Read-only/.test(v.querySelector('.fx-pv-foot').textContent), on:!v.hidden&&document.body.classList.contains('sf-file-on'),
        active:!!document.querySelector('#chatTabs .sf-notestab.on'), scroll:getComputedStyle(v.querySelector('.sf-notes')).overflowY}})()`,
    );
    assertEquals(view.versions, [`AIB ${APP_VERSION}`, `AIB ${OLD}`, `AIB ${OLDER}`], 'every release, newest first, no draft');
    assert(view.metas[0].startsWith('Installed now · ') && view.metas[0].length > 'Installed now · '.length, view.metas[0]);
    assert(view.metas[1].startsWith('Earlier release · '), view.metas[1]);
    assert(view.h >= 1 && view.strong >= 1, 'the notes render as Markdown');
    assert(view.ro && view.on && view.active, JSON.stringify(view));
    assertEquals(view.scroll, 'auto', 'the list scrolls');
    assertEquals(
      await page.eval<boolean>(`(function(){var b=document.getElementById('updateButton');return !b||b.hidden})()`),
      true,
      'installed: no Update button',
    );
    await page.shot('update-notes-tab');
    assertEquals(page.errors, [], 'no page errors');
    // ---- 3. never again ---------------------------------------------------------------------------------------------------------
    assertEquals((await web.get('/api/live/update/notes'))[1], { notes: null }, 'the page told the server');
    await page.goto(`http://127.0.0.1:${web.port}/`);
    await page.waitFor(`!!document.getElementById('chatTabs')`, 30_000, 'the page again');
    await sleep(5_000); // the first status poll (and the notes question) comes 3 s after start
    assertEquals(
      await page.eval<number>(`document.querySelectorAll('#chatTabs .sf-notestab').length`),
      0,
      'a reload does not open the notes again',
    );
    await page.close();
  } finally {
    await web.kill();
  }
}
