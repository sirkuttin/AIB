/**
 * The local test feed, end to end: a real Studio server (source run, own temp data folder, a port the OS picked) that takes itself
 * to be a test build (AIB_UPDATE_CURRENT, honoured with AIB_TEST_FEED_DIR) and a temp feed folder written by tools/build.ts's
 * writeFeed. No GitHub (the source run's placeholder repository), no network, nothing installed, no window.
 *
 *   1. The window-focus route (POST update/check {feed: true}) reads the feed: the newer test build is copied in, verified against
 *      the feed's SHA256SUMS and reported ready; the status says this is a feed build. The older feed version is not offered.
 *   2. Started again on the same data folder as that version (what the update helper does after the swap): the server offers the
 *      feed's notes for the "What's new" tab, newest first.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, SEP, TEST_OPTIONS } from './_host_fixture.ts';
import { APP_VERSION } from '../../outputs/agent-studio/server/core/app.ts';
import { parseVersion } from '../../outputs/agent-studio/server/desktop/updater.ts';
import { writeFeed } from '../../tools/build.ts';

const base = APP_VERSION.replace(/\.test\..*$/, '');
const CURRENT = `${base}.test.1`, PREVIOUS = `${base}.test.0`, NEXT = `${base}.test.2`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name: 'a test build reads its local feed, copies the newer version in, verifies it, reports it ready, then shows its notes',
  ...TEST_OPTIONS,
  async fn() {
    assert(parseVersion(NEXT), NEXT);
    await using fx = new Fixture();
    const r = fx.root;
    for (const d of ['appdata', 'localappdata', 'home', 'feed', 'src']) Deno.mkdirSync(`${r}${SEP}${d}`, { recursive: true });
    const feed = `${r}${SEP}feed`;
    for (const [version, notes] of [[PREVIOUS, '- The previous test build.\n'], [NEXT, '- **Feed** notes for the next test build.\n']]) {
      const zip = `${r}${SEP}src${SEP}AIB-${version}-windows-x64.zip`;
      Deno.writeTextFileSync(zip, `not a real AIB ${version}`.repeat(100));
      await writeFeed(feed, version, zip, { notes, commit: 'abc1234', date: '2026-11-16T10:00:00Z' });
    }
    const home = `${r}${SEP}home`;
    const env = (current: string) => ({
      USERPROFILE: home,
      HOME: home,
      APPDATA: `${r}${SEP}appdata`,
      LOCALAPPDATA: `${r}${SEP}localappdata`,
      CODEX_HOME: `${home}${SEP}.codex`,
      AIB_TEST_FEED_DIR: feed,
      AIB_UPDATE_CURRENT: current,
    });
    // ---- 1. the focus route reads the feed ----------------------------------------------------------------------------------
    let web = await fx.startWeb(['--in-process', '--no-auto-reconnect'], { env: env(CURRENT) });
    try {
      let st = (await web.get('/api/live/update'))[1] as Record<string, unknown>;
      assertEquals([st.current, st.feed, st.configured, st.desktop], [CURRENT, true, true, false], JSON.stringify(st));
      const [code] = await web.post('update/check', { feed: true });
      assertEquals(code, 200);
      for (const until = Date.now() + 60_000; Date.now() < until;) {
        st = (await web.get('/api/live/update'))[1] as Record<string, unknown>;
        if (!st.checking && (st.state === 'ready' || st.state === 'refused' || st.state === 'error')) break;
        await sleep(200);
      }
      assertEquals(st.state, 'ready', JSON.stringify(st));
      const available = st.available as Record<string, unknown>;
      assertEquals(available.version, NEXT);
      assertEquals(available.name, `AIB-${NEXT}-windows-x64.zip`);
      const path = String(available.path);
      assert(path.startsWith(fx.root) && !path.startsWith(feed), `copied into the data folder: ${path}`);
      const sums = Deno.readTextFileSync(`${feed}${SEP}${NEXT}${SEP}SHA256SUMS`);
      assert(sums.includes(`${available.sha256}  AIB-${NEXT}-windows-x64.zip`), 'verified against the feed SHA256SUMS');
      assert(typeof st.instructions === 'string', 'a source run cannot install in place: instructions, nothing installed');
      assertEquals((await web.get('/api/live/update/notes'))[1], { notes: null }, 'no notes while the old version runs');
    } finally {
      await web.kill();
    }
    // ---- 2. running the new version: its feed notes, once --------------------------------------------------------------------
    web = await fx.startWeb(['--in-process', '--no-auto-reconnect'], { env: env(NEXT) });
    try {
      const st = (await web.get('/api/live/update'))[1] as Record<string, unknown>;
      assertEquals([st.current, st.state], [NEXT, 'none'], JSON.stringify(st));
      const notes = (await web.get('/api/live/update/notes'))[1].notes as { version: string; releases: { version: string; body: string }[] };
      assertEquals(notes.version, NEXT);
      assertEquals(notes.releases.map((n) => [n.version, n.body]), [
        [NEXT, '- **Feed** notes for the next test build.'],
        [PREVIOUS, '- The previous test build.'],
      ]);
    } finally {
      await web.kill();
    }
  },
});
