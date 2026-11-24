/**
 * N1 and N2, server side (multi-window design section 5; the page side and T5's headless half are Phase 1B's).
 *   N1  with another app window open (K4 othersAlive), chat.html's aibViewPrefs block says "seed": "missing-only", so a newly
 *       loaded window fills in only the view-pref keys localStorage lacks and never writes the server's older value over a newer
 *       one another window just wrote. Alone (or in serve mode) the block is as before.
 *   N2  per-window keys (<key>:w2 … :w8) are saved to the server like their unsuffixed key.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeDesktopWindows } from './_fake_desktop_windows.ts';
import { ViewPrefs } from '../../app/server/state/view_prefs.ts';
import { makeContext, WebServer } from '../../app/server/web/server.ts';
import type { LiveBackend } from '../../app/server/host/backend.ts';
import type { UpdateService } from '../../app/server/desktop/updater.ts';
import type { Source } from '../../app/server/transcripts/monitor.ts';

const block = (page: string) => {
  const m = page.match(/<script type="application\/json" id="aibViewPrefs">([\s\S]*?)<\/script>/);
  assert(m, 'the data block is in the page');
  return JSON.parse(m[1]) as { prefs: Record<string, string>; seed?: string };
};

Deno.test('N1: chat.html says seed "missing-only" only while another AIB window is open', async () => {
  const stateDir = await Deno.makeTempDir({ prefix: 'aib-view-windows-' });
  const ctx = makeContext({
    stateDir,
    host: {} as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
    keepAwakeBackend: null,
  });
  const server = new WebServer(ctx);
  const port = await server.listen(0); // a free port the OS picks
  const origin = `http://127.0.0.1:${port}`;
  const page = async (query = '') => block(await (await fetch(`${origin}/${query}`)).text());
  try {
    await ctx.viewPrefs.update({ set: { 'studio-side-hidden': '1' } });
    // serve mode (no desktop app): today's block, no seed key
    assertEquals(await page('?w=w2'), { prefs: { 'studio-side-hidden': '1' } });
    const dw = new FakeDesktopWindows(origin);
    ctx.desktopWindows = dw;
    // only the main window: it seeds everything, as today
    assertEquals((await page('?w=m')).seed, undefined);
    assertEquals((await page()).seed, undefined, 'no ?w= (S6) counts as the main window');
    await dw.open({ project: { key: 'p', name: 'p', path: '/p' } }, 'm');
    // the new window w2 loads while m is open: missing-only
    const second = await page('?w=w2&kind=project&project=p');
    assertEquals(second, { prefs: { 'studio-side-hidden': '1' }, seed: 'missing-only' });
    // and m reloading while w2 is open: missing-only too
    assertEquals((await page('?w=m')).seed, 'missing-only');
    assertEquals((await page('?w=bogus')).seed, 'missing-only', 'a bad ?w= counts as m');
    dw.close('w2');
    assertEquals((await page('?w=m')).seed, undefined, 'alone again');
  } finally {
    await server.close();
    await Deno.remove(stateDir, { recursive: true }).catch(() => {});
  }
});

Deno.test('N2: per-window keys (:w2 … :w8) are view-pref keys the server saves', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'aib-view-windows-' });
  try {
    const store = new ViewPrefs(dir);
    const keys = [
      'studio-side-hidden:w2',
      'studio-activity-hidden:w8',
      'aib-sidebar-mode:w3',
      'studio-layout-v1:right:<1400:w4', // a prefix key with its width bucket, then the window
    ];
    const r = await store.update({ set: Object.fromEntries(keys.map((k) => [k, '1'])) });
    assertEquals(r.refused, []);
    assertEquals(Object.keys(new ViewPrefs(dir).public().prefs).sort(), [...keys].sort(), 'saved and read back');
    for (const k of keys) assertEquals(ViewPrefs.key(k), k);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
