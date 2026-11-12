/**
 * Real binaries, end to end (slow: two `deno desktop` builds; run with AIB_SLOW_TESTS=1, Windows only). Everything runs on an
 * invisible desktop (_hidden_desktop.ts) with a temp data folder, temp APPDATA/LOCALAPPDATA, a page port the OS picked and
 * WebView2's DevTools on a port it picked itself (--remote-debugging-port=0, read back from DevToolsActivePort).
 *
 *   1. Build AIB at APP_VERSION (A) and at NEXT_VERSION (B); install A from its zip into a temp folder.
 *   2. Start A (the desktop app, no --port: it reuses the port saved in desktop-port.json). Write a localStorage key through the
 *      WebView2 DevTools port (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), open a chat with the fake agent and start a turn that waits.
 *   3. Check for updates against a local fake release server serving B (zip, SHA256SUMS, release.json) and click Install now while
 *      the chat works: A quits, the update helper swaps the files (journaled, with its tray presence), starts B and waits for B's
 *      start confirmation.
 *   4. B comes up on the same port, attaches to A's agent host (same product), the chat is still working there, the localStorage
 *      key is still readable, and the old version's files the host runs from are not deleted.
 *   5. The turn is cancelled through B: B drains, the old host stops, a host of B's version takes over, the old files go.
 *   6. Closing B's window with nothing working leaves no AIB process within seconds. Logs tell the story.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, httpJson, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { builtDist, NEXT_VERSION } from './_build_cache.ts';
import { devToolsPortNow, ownerPort, pickPort } from './_ports.ts';
import { HostClient, pidAlive, readInfo } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_VERSION } from '../../outputs/agent-studio/server/core/app.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
/** OS-chosen (after the builds), with port + 1 free: the update must bring B back on this same port (desktop-port.json), where
 * localStorage lives. */
let PORT = 0;
/** The app folder: WebView2 keeps its profile next to the exe (AIB.exe.WebView2); its DevToolsActivePort names the CDP port, new
 * after every restart. */
let cdpRoot = '';
const NEXT = NEXT_VERSION; // one B for every update test: one cached build
type Json = Record<string, unknown>;


async function cdpEval(expression: string): Promise<unknown> {
  const cdp = devToolsPortNow(cdpRoot);
  if (!cdp) throw new Error('no DevToolsActivePort yet');
  const targets = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json() as Json[];
  const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(`http://127.0.0.1:${PORT}`));
  if (!page) throw new Error('no page target yet');
  const ws = new WebSocket(String(page.webSocketDebuggerUrl));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const answer = new Promise<Json>((resolve) => (ws.onmessage = (e) => resolve(JSON.parse(e.data))));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const reply = await answer;
    return ((reply.result as Json)?.result as Json)?.value;
  } finally {
    ws.close();
  }
}

/** Every process whose program is under `folder` (Win32_Process), as [pid, path]. */
async function processesUnder(folder: string): Promise<[number, string][]> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${
    folder.replaceAll("'", "''")
  }', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
  const r = await new Deno.Command('powershell', { args: ['-NoProfile', '-NonInteractive', '-Command', script], stdout: 'piped' }).output();
  return new TextDecoder().decode(r.stdout).split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, path] = l.split('|');
    return [Number(pid), path];
  });
}

function fakeReleases(dist: string): Deno.HttpServer<Deno.NetAddr> {
  const zip = `AIB-${NEXT}-windows-x64.zip`;
  const files: Record<string, string> = { '/a/zip': zip, '/a/sums': 'SHA256SUMS', '/a/info': 'release.json' };
  const box: { port: number } = { port: 0 };
  const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req): Response => {
    const path = new URL(req.url).pathname;
    const base: string = `http://127.0.0.1:${box.port}`;
    if (path.startsWith('/repos/acme/aib/releases')) {
      const asset = (name: string, url: string): Json => ({ name, state: 'uploaded', size: Deno.statSync(`${dist}\\${name}`).size, url: base + url });
      return Response.json([{
        tag_name: `v${NEXT}`,
        draft: false,
        prerelease: true,
        html_url: '',
        assets: [asset(zip, '/a/zip'), asset('SHA256SUMS', '/a/sums'), asset('release.json', '/a/info')],
      }]);
    }
    if (files[path]) return new Response(Deno.readFileSync(`${dist}\\${files[path]}`));
    return new Response('no', { status: 404 });
  });
  box.port = server.addr.port;
  return server;
}

Deno.test({
  name: 'real binaries: Install now while a chat works keeps it running, keeps localStorage and the port, then hands the host over',
  ignore: !SLOW,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using fx = new Fixture();
    const install = `${fx.root}\\install`, trays = `${fx.root}\\trays`;
    const [distA, distB] = await Promise.all([builtDist(), builtDist(NEXT)]); // built once per source, shared (_build_cache.ts)
    Deno.mkdirSync(install);
    Deno.mkdirSync(trays);
    const tar = await new Deno.Command('C:\\Windows\\System32\\tar.exe', {
      args: ['-xf', `${distA}\\AIB-${APP_VERSION}-windows-x64.zip`, '-C', install],
    }).output();
    assert(tar.success, 'unzip A');
    const app = `${install}\\AIB`;
    const exe = `${app}\\AIB.exe`;
    const releases = fakeReleases(distB);
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    const env: Record<string, string> = {
      AGENT_STUDIO_STATE_DIR: fx.state,
      APPDATA: `${fx.root}\\appdata`,
      LOCALAPPDATA: `${fx.root}\\localappdata`,
      AIB_UPDATE_API_BASE: `http://127.0.0.1:${releases.addr.port}`,
      AIB_UPDATE_REPO: 'acme/aib',
      AIB_TEST_TRAY_STATE: trays,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
      // The built app cannot see work/ (its code is embedded), so its test guard is told the agent is the fake one (fake_acp.py).
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1',
    };
    for (const d of [env.APPDATA, env.LOCALAPPDATA]) Deno.mkdirSync(d, { recursive: true });
    cdpRoot = app;
    PORT = pickPort(true);
    Deno.writeTextFileSync(`${fx.state}\\desktop-port.json`, JSON.stringify({ port: PORT })); // "the port used last time"
    const pids = new Set<number>();
    try {
      for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
      const flags = fx.agentFlags().filter((_, i, a) => a[i] !== '--state-dir' && a[i - 1] !== '--state-dir');
      const aPid = desk.spawn([exe, ...flags], app);
      pids.add(aPid);
      for (const k of Object.keys(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);

      // ---- A runs, a chat works, a draft is in localStorage
      const bootA = await until(async () => {
        const [s, b] = await httpJson('GET', PORT, '/api/live/bootstrap', null, undefined, 3000);
        return s === 200 ? b : null;
      }, 'A on the saved port', 60);
      const tokenA = String(bootA.token);
      const hostA = (await readInfo(fx.state))!;
      pids.add(hostA.pid!);
      await until(() => cdpEval(`localStorage.setItem('aib-e2e-draft', 'kept across the update'), 'ok'`), 'localStorage write', 60);
      const post = (port: number, token: string, name: string, body: unknown) => httpJson('POST', port, '/api/live/' + name, token, body);
      const [cs, conn] = await post(PORT, tokenA, 'connect', { provider: 'claude', cwd: fx.workspace, background: true });
      assertEquals(cs, 200, JSON.stringify(conn));
      const cid = String(conn.id);
      const state = async (token: string) => (await httpJson('GET', PORT, `/api/live/state?id=${cid}`, token))[1];
      await until(async () => (await state(tokenA)).ready, 'chat ready', 60);
      assertEquals((await post(PORT, tokenA, 'prompt', { id: cid, text: 'wait', clientMessageId: 'e2e-1' }))[0], 200);
      await until(async () => (await state(tokenA)).busy, 'turn working');

      // ---- Install now while it works
      await post(PORT, tokenA, 'update/check', {});
      await until(async () => (await httpJson('GET', PORT, '/api/live/update', tokenA))[1].state === 'ready', 'update ready', 120);
      const [is, installing] = await post(PORT, tokenA, 'update/install', {});
      assertEquals([is, installing.state, installing.chats], [200, 'installing', 1], JSON.stringify(installing));
      await until(() => !pidAlive(aPid), 'A quit', 60);
      assert(pidAlive(hostA.pid!), "the agent host outlived A's quit");

      // ---- B: same port, same host, the chat still works, the draft is there
      const bootB = await until(async () => {
        const [s, b] = await httpJson('GET', PORT, '/api/live/bootstrap', null, undefined, 3000);
        return s === 200 && b.token !== tokenA ? b : null;
      }, 'B on the same port', 120);
      const tokenB = String(bootB.token);
      const owner = JSON.parse(Deno.readTextFileSync(`${fx.state}\\aib-owner.json`));
      pids.add(owner.pid);
      assertEquals((await httpJson('GET', PORT, '/api/live/update', tokenB))[1].current, NEXT, 'B runs');
      assertEquals(bootB.hostPid, hostA.pid, 'B attached to the running host of A');
      assert((await state(tokenB)).busy, 'the chat is still working, now seen through B');
      await until(
        () => Deno.readTextFileSync(`${fx.state}\\updates\\install.log`).includes('the new version is running (it confirmed its start)'),
        'the helper saw the start confirmation (B loaded its page)',
        60,
      );
      assertEquals(await until(() => cdpEval(`localStorage.getItem('aib-e2e-draft')`), 'localStorage read', 60), 'kept across the update');
      const old = () => [...Deno.readDirSync(app)].map((e) => e.name).filter((n) => /\.old-\d{8}-\d{6}/.test(n));
      assert(old().some((n) => n.startsWith('AIB.exe.old-')), "the old exe the host runs from is kept: " + old().join(', '));
      const helperTray = [...Deno.readDirSync(trays)].find((e) => e.name.startsWith('helper-'));
      assert(helperTray, 'the update helper showed a tray icon');
      // The host showed its own icon in the gap between A and B (a chat working, no app), and hid it when B attached.
      const hostLogGap = Deno.readTextFileSync(`${fx.state}/agent-host.log`);
      assert(hostLogGap.includes('shown tray icon: AIB · 1 chat running'), hostLogGap.slice(-3000));
      assert(hostLogGap.includes('tray icon hidden: an app attached'), hostLogGap.slice(-3000));
      const hostTray = JSON.parse(Deno.readTextFileSync(`${trays}/host-${hostA.pid}.json`));
      assertEquals([hostTray.shown, hostTray.items], [false, ['Open AIB', '', 'Stop chats and quit']]);

      // ---- the turn ends; B drains and hands over to a host of its own version
      assertEquals((await post(PORT, tokenB, 'cancel', { id: cid }))[0], 200);
      const hostB = await until(async () => {
        const info = await readInfo(fx.state);
        return info && info.pid !== hostA.pid ? info : null;
      }, 'handover to a new host', 60);
      pids.add(hostB.pid!);
      await until(() => !pidAlive(hostA.pid!), 'old host gone', 30);
      assertEquals((await new HostClient(hostB).call('info', null, 10) as Json).version, NEXT);
      await until(() => old().length === 0, 'the old version files deleted once nothing runs from them', 30);
      const hostLog = Deno.readTextFileSync(`${fx.state}\\agent-host.log`);
      assert(/stop asked by AIB 0\.1\.0-beta\.99 \(pid \d+\) handing over/.test(hostLog), hostLog.slice(-3000));
      const studioLog = Deno.readTextFileSync(`${fx.state}\\studio.log`);
      assert(studioLog.includes('Drain: handing over from the agent host of AIB'), studioLog.slice(-3000));
      assert(studioLog.includes('closing (installing an update)'), 'A logged why it quit');

      // ---- close B's window with nothing working: no AIB process left. The new host reconnects the idle chat in the background
      // first ("opening" counts as working, and closing then asks): wait until nothing works.
      await until(async () => ((await new HostClient(hostB).call('busy', null, 10) as Json).busy as unknown[]).length === 0, 'reconnect done', 60);
      const win = desk.windows().find((w) => w.pid === owner.pid && w.title === 'AIB' && w.visible);
      assert(win, 'B has its window');
      desk.post(win!, 0x10); // WM_CLOSE: the person closes the window
      await until(async () => (await processesUnder(install)).length === 0, 'no AIB process left', 30);
    } finally {
      for (const [k] of Object.entries(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
      for (const [pid] of await processesUnder(install).catch(() => [] as [number, string][])) pids.add(pid);
      for (const pid of pids) {
        if (pidAlive(pid)) {
          try {
            Deno.kill(pid, 'SIGKILL');
          } catch { /* gone */ }
        }
      }
      await releases.shutdown();
      await new Promise((r) => setTimeout(r, 1500));
      desk.close();
    }
  },
});

Deno.test({
  name: 'real binary: the app crashes with a chat working; the host shows its tray (no window of its own); Stop chats and quit asks, then ends everything',
  ignore: !SLOW,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using fx = new Fixture();
    const install = `${fx.root}/install`, trays = `${fx.root}/trays`;
    const dist = await builtDist();
    Deno.mkdirSync(install);
    Deno.mkdirSync(trays);
    await new Deno.Command('C:/Windows/System32/tar.exe', { args: ['-xf', `${dist}/AIB-${APP_VERSION}-windows-x64.zip`, '-C', install] })
      .output();
    const app = `${install}/AIB`;
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    const env: Record<string, string> = {
      AGENT_STUDIO_STATE_DIR: fx.state,
      APPDATA: `${fx.root}/appdata`,
      LOCALAPPDATA: `${fx.root}/localappdata`,
      AIB_TEST_TRAY_STATE: trays,
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1',
    };
    for (const d of [env.APPDATA, env.LOCALAPPDATA]) Deno.mkdirSync(d, { recursive: true });
    const pids = new Set<number>();
    try {
      for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
      const flags = fx.agentFlags().filter((_, i, a) => a[i] !== '--state-dir' && a[i - 1] !== '--state-dir');
      const aPid = desk.spawn([`${app}/AIB.exe`, '--port', '0', ...flags], app); // the OS picks; aib-owner.json says which
      pids.add(aPid);
      for (const k of Object.keys(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
      const port = await ownerPort(fx.state, 60); // a fresh data folder: its owner is this app
      const boot = await until(async () => {
        const [s, b] = await httpJson('GET', port, '/api/live/bootstrap', null, undefined, 3000);
        return s === 200 ? b : null;
      }, 'app up', 60);
      const token = String(boot.token);
      const host = (await readInfo(fx.state))!;
      pids.add(host.pid!);
      const post = (name: string, body: unknown) => httpJson('POST', port, '/api/live/' + name, token, body);
      const [, conn] = await post('connect', { provider: 'claude', cwd: fx.workspace, background: true });
      const cid = String(conn.id);
      await until(async () => (await httpJson('GET', port, `/api/live/state?id=${cid}`, token))[1].ready, 'chat ready', 60);
      await post('prompt', { id: cid, text: 'wait', clientMessageId: 'crash-1' });
      await until(async () => (await httpJson('GET', port, `/api/live/state?id=${cid}`, token))[1].busy, 'working');
      Deno.kill(aPid, 'SIGKILL'); // the app crashes: no detach
      const started = Date.now();
      const trayFile = `${trays}/host-${host.pid}.json`;
      await until(() => JSON.parse(Deno.readTextFileSync(trayFile)).shown === true, 'host tray shown', 45);
      const after = (Date.now() - started) / 1000;
      assert(after >= 20 && after <= 35, `shown once the missed heartbeats count (25 s): ${after}`);
      const tray = JSON.parse(Deno.readTextFileSync(trayFile));
      assertEquals(tray.tooltip, `AIB · 1 chat running (data: ${fx.state})`);
      // The tray worker's (hidden) window appears a moment after the state file says "shown".
      const trayWindow = await until(() => desk.windows().find((w) => w.pid === host.pid && w.cls === 'AIBTrayWindow'), 'tray worker window', 15);
      const hostWindows = desk.windows().filter((w) => w.pid === host.pid);
      assert(!hostWindows.some((w) => w.visible), 'the host has no visible window: ' + JSON.stringify(hostWindows.map((w) => w.cls)));
      desk.post(trayWindow!, 0x8000 + 5, 3n); // TRAY_COMMAND: menu item 3, Stop chats and quit
      const box = await until(() => desk.windows().find((w) => w.pid === host.pid && w.cls === '#32770' && w.visible), 'the confirm box', 15);
      assert(pidAlive(host.pid!), 'nothing stops before the answer');
      desk.post(box, 0x111, 1n); // WM_COMMAND IDOK
      await until(() => !pidAlive(host.pid!), 'host stopped', 30);
      await until(async () => (await processesUnder(install)).length === 0, 'no AIB process left', 15);
      const log = Deno.readTextFileSync(`${fx.state}/agent-host.log`);
      assert(log.includes('forced stop asked by the tray menu'), log.slice(-2000));
    } finally {
      for (const [k] of Object.entries(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
      for (const [pid] of await processesUnder(install).catch(() => [] as [number, string][])) pids.add(pid);
      for (const pid of pids) {
        if (pidAlive(pid)) {
          try {
            Deno.kill(pid, 'SIGKILL');
          } catch { /* gone */ }
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
      desk.close();
    }
  },
});
