/**
 * The page's view and appearance preferences in the state folder (state/view_prefs.ts): the store, the data block in chat.html and
 * POST /api/live/view-prefs behind the page gate. The page half (view-prefs.js) is tested in work/test_view_prefs.js.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { ViewPrefs, ViewPrefsBusy } from '../../outputs/agent-studio/server/state/view_prefs.ts';
import { makeContext, WebServer, withViewPrefs } from '../../outputs/agent-studio/server/web/server.ts';
import { ValueError } from '../../outputs/agent-studio/server/core/py.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';

Deno.test('view prefs: saved in studio-view.json, read back by a new store, null removes, invalid patches change nothing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'aib-view-' });
  try {
    const store = new ViewPrefs(dir);
    assertEquals(store.public().prefs, {});
    assertEquals(
      await store.update({
        set: {
          'studio-workspace-v1': '{"active":"all"}',
          'studio-textsize-v1:<1800': '{"chat":120}',
        },
      }),
      { changed: true, refused: [] },
    );
    assertEquals(
      await store.update({
        set: { 'studio-workspace-v1': '{"active":"all"}' },
      }),
      { changed: false, refused: [] },
      'no change, no save',
    );
    const again = new ViewPrefs(dir);
    assertEquals(again.public().prefs, {
      'studio-workspace-v1': '{"active":"all"}',
      'studio-textsize-v1:<1800': '{"chat":120}',
    });
    await again.update({ set: { 'studio-textsize-v1:<1800': null } });
    assertEquals(store.public().prefs, {
      'studio-workspace-v1': '{"active":"all"}',
    }, 'another instance sees the file change');
    const file = JSON.parse(
      Deno.readTextFileSync(`${dir}${sep}studio-view.json`),
    );
    assertEquals([file.version, file.prefs], [1, {
      'studio-workspace-v1': '{"active":"all"}',
    }]);
    for (const bad of [null, {}, { set: 'x' }, { set: [] }]) await assertRejects(() => store.update(bad), ValueError);
    // a bad key or value is refused on its own; it never costs the good ones in the same request
    for (
      const [bad, name] of [
        [{ 'not-ours': '1' }, 'not-ours'],
        [{ 'studio-x': 5 }, 'studio-x'],
        [{ '../evil': 'x' }, '../evil'],
        [{ 'studio-x': 'x'.repeat(ViewPrefs.MAX_VALUE + 1) }, 'studio-x'],
      ] as [Record<string, unknown>, string][]
    ) {
      assertEquals(await store.update({ set: { ...bad, 'studio-side-hidden': '1' } }), { changed: true, refused: [name] });
      await store.update({ set: { 'studio-side-hidden': null } });
    }
    assertEquals(store.public().prefs, {
      'studio-workspace-v1': '{"active":"all"}',
    });
    // the total size is capped too: the values that do not fit are refused, the small ones (the project, the tabs) still saved
    const big = 'x'.repeat(ViewPrefs.MAX_VALUE);
    const many: Record<string, string> = { 'studio-workspace-v1': '{"active":"w:c:/p"}' };
    const fit = Math.floor(ViewPrefs.MAX_TOTAL / ViewPrefs.MAX_VALUE) - 1;
    for (let i = 0; i < fit + 3; i++) many[`studio-big-${i}`] = big;
    const r = await store.update({ set: many });
    assertEquals(r.changed, true);
    assertEquals(r.refused.length, 3, JSON.stringify(r.refused));
    assertEquals(store.public().prefs['studio-workspace-v1'], '{"active":"w:c:/p"}');
    assert(Object.values(store.public().prefs).reduce((n, v) => n + v.length, 0) <= ViewPrefs.MAX_TOTAL);
    const back = new ViewPrefs(dir).public().prefs;
    assertEquals(back['studio-workspace-v1'], '{"active":"w:c:/p"}', 'and it is on disk');
    // a corrupt file is set aside, not fatal
    Deno.writeTextFileSync(`${dir}${sep}studio-view.json`, '{nope');
    assertEquals(new ViewPrefs(dir).public().prefs, {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('view prefs: a file that cannot be written just now is a ViewPrefsBusy (503, sent again), and nothing changes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'aib-view-busy-' });
  try {
    const store = new ViewPrefs(dir);
    await store.update({ set: { 'studio-workspace-v1': 'a' } });
    // the file's place taken by a folder: the save fails with an OS error
    Deno.removeSync(`${dir}${sep}studio-view.json`);
    Deno.mkdirSync(`${dir}${sep}studio-view.json`);
    Deno.writeTextFileSync(`${dir}${sep}studio-view.json${sep}x`, 'x');
    const fresh = new ViewPrefs(dir);
    await assertRejects(() => fresh.update({ set: { 'studio-workspace-v1': 'b' } }), ViewPrefsBusy);
    assertEquals(fresh.public().prefs['studio-workspace-v1'], undefined, 'not taken as saved');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('view prefs: the state a new copy of the app needs survives a restart from another folder (store level)', async () => {
  // what a page from another build folder writes, read back by a new process on the same data folder
  const dir = await Deno.makeTempDir({ prefix: 'aib-view-move-' });
  try {
    const ws = JSON.stringify({
      v: 1,
      active: 'w:c:/repos/app',
      tabs: { 'w:c:/repos/app': ['claude:s1'] },
      last: { 'w:c:/repos/app': 'claude:s1' },
    });
    await new ViewPrefs(dir).update({
      set: {
        'studio-workspace-v1': ws,
        'aib-file-tabs-v1': '{"w:c:/repos/app":{"tabs":[{"path":"README.md","scope":{"id":"main"}}]}}',
        'aib-files-open-v1': '{"w:c:/repos/app\nmain":["src"]}',
        'studio-seen-turns': '{"claude:s1":1700000000}',
      },
    });
    const prefs = new ViewPrefs(dir).public().prefs;
    assertEquals(prefs['studio-workspace-v1'], ws);
    assertEquals(Object.keys(prefs).sort(), ['aib-file-tabs-v1', 'aib-files-open-v1', 'studio-seen-turns', 'studio-workspace-v1']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('view prefs: no state folder keeps them in memory only', async () => {
  const store = new ViewPrefs(null);
  await store.update({ set: { 'studio-side-hidden': '1' } });
  assertEquals(store.public().prefs, { 'studio-side-hidden': '1' });
});

Deno.test('chat.html carries the saved values in a JSON data block that no value can break out of', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  const out = withViewPrefs(html, {
    'studio-conversation-names': '{"a":"</script><script>alert(1)</script>"}',
  });
  const m = out.match(
    /<script type="application\/json" id="aibViewPrefs">([\s\S]*?)<\/script><\/head>/,
  );
  assert(m, out);
  assert(!m[1].includes('<'), 'every < is escaped');
  assertEquals(
    JSON.parse(m[1]).prefs['studio-conversation-names'],
    '{"a":"</script><script>alert(1)</script>"}',
  );
  assertEquals(withViewPrefs('<p>no head</p>', { a: '1' }), '<p>no head</p>');
  // the saved theme goes on <html> for themes.js; only a plain id is written
  const themed = withViewPrefs('<!doctype html><html lang="en"><head></head></html>', { 'aib-theme': 'teal-light' });
  assert(themed.startsWith('<!doctype html><html data-theme-pref="teal-light" lang="en">'), themed);
  const bad = withViewPrefs('<html lang="en"><head></head></html>', { 'aib-theme': '"><script>' });
  assert(!bad.includes('data-theme-pref'), bad);
});

Deno.test('the web server: chat.html has the saved values, POST /api/live/view-prefs saves behind the page gate', async () => {
  const stateDir = await Deno.makeTempDir({ prefix: 'aib-view-web-' });
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
  });
  const server = new WebServer(ctx);
  let port = 0;
  for (let p = 8871; p <= 8889 && !port; p++) {
    try {
      port = await server.listen(p);
    } catch {
      /* in use: try the next one */
    }
  }
  assert(port, 'no free port in 8871-8889');
  const origin = `http://127.0.0.1:${port}`;
  const post = (
    body: unknown,
    headers: Record<string, string> = {
      'X-Studio-Token': ctx.token,
      Origin: origin,
    },
  ) =>
    fetch(`${origin}/api/live/view-prefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    let r = await post({
      set: { 'studio-workspace-v1': '{"v":1,"active":"all"}' },
    });
    assertEquals(r.status, 200);
    assertEquals((await r.json()).ok, true);
    r = await post({ set: { 'studio-side-hidden': '1' } }, { Origin: origin });
    assertEquals(r.status, 403, 'the page token is required');
    await r.body?.cancel();
    r = await post({ set: { 'studio-side-hidden': '1' } }, {
      'X-Studio-Token': ctx.token,
      Origin: 'http://evil.example',
    });
    assertEquals(r.status, 403, 'another origin is refused');
    await r.body?.cancel();
    r = await post({ set: { nope: '1' } });
    assertEquals(r.status, 200, 'a bad key is refused on its own');
    assertEquals((await r.json()).refused, ['nope']);
    r = await post({ set: 'nope' });
    assertEquals(r.status, 400, 'a malformed body');
    await r.body?.cancel();
    const page = await (await fetch(`${origin}/`)).text();
    const m = page.match(
      /<script type="application\/json" id="aibViewPrefs">([\s\S]*?)<\/script>/,
    );
    assert(m, 'the data block is in the page');
    assertEquals(JSON.parse(m[1]).prefs, {
      'studio-workspace-v1': '{"v":1,"active":"all"}',
    });
    assert(page.indexOf('id="aibViewPrefs"') < page.indexOf('</head>'));
    assert(
      Deno.statSync(`${stateDir}${sep}studio-view.json`).isFile,
      'kept in the state folder',
    );
  } finally {
    await server.close();
    await Deno.remove(stateDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("view prefs: a page's older batch that arrives after its newer one does not overwrite it (the page does not wait between saves)", async () => {
  const dir = await Deno.makeTempDir({ prefix: 'aib-view-' });
  try {
    const store = new ViewPrefs(dir);
    const ws = (a: string) => JSON.stringify({ active: a });
    await store.update({ set: { 'studio-workspace-v1': ws('delta'), 'aib-theme': 'dark' }, page: 'p1', seq: 3 });
    // batch 2 of the same page comes late: its workspace is older, its other key no newer batch carried
    await store.update({ set: { 'studio-workspace-v1': ws('beta'), 'studio-side-hidden': '1' }, page: 'p1', seq: 2 });
    assertEquals(store.public().prefs['studio-workspace-v1'], ws('delta'), 'the pick stays');
    assertEquals(store.public().prefs['studio-side-hidden'], '1', "the late batch's other keys are saved");
    // another page (a reload, a second window): last writer wins, as before
    await store.update({ set: { 'studio-workspace-v1': ws('alpha') }, page: 'p2', seq: 1 });
    assertEquals(store.public().prefs['studio-workspace-v1'], ws('alpha'));
    // a body without page/seq (an older page script) always applies
    await store.update({ set: { 'studio-workspace-v1': ws('gamma') } });
    assertEquals(store.public().prefs['studio-workspace-v1'], ws('gamma'));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
