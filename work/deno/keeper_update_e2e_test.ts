/**
 * Keeper step 2 with real binaries, end to end (slow: two `deno desktop` builds; AIB_SLOW_TESTS=1, Windows only): Install now while a
 * chat streams, with the keeper on (the default: no setting, no AIB_KEEPER; one AIB process). Everything runs on an invisible desktop (_hidden_desktop.ts) with
 * a temp data folder, temp APPDATA/LOCALAPPDATA, a page port the OS picked and WebView2's DevTools on a port it picked itself
 * (--remote-debugging-port=0, read back from DevToolsActivePort); only processes this test started are killed. This file took over
 * app_update_e2e_test.ts, the same update from the separate-agent-host era: its localStorage and update-helper tray checks are here.
 *
 *   1. Build AIB at APP_VERSION (A) and at NEXT_VERSION (B), each with its keeper; install A from its zip into a temp folder.
 *   2. Start A (no --port: it reuses desktop-port.json). One process, no agent host (hostMode 'keeper'). A chat with the fake agent
 *      (work/keeper-fixture/agent.mjs) streams 40 chunks, 150 ms apart, and asks a question after chunk 19.
 *   3. Check for updates against a local fake GitHub releases API serving B (zip, SHA256SUMS, release.json) and click Install now
 *      mid-turn: A leaves the chat in the keeper and quits, the update helper (with its tray presence) stays connected to the keeper
 *      while it swaps the files, starts B and waits for B's start confirmation.
 *   4. B takes the chat over from the keeper's record under the same connection id: every chunk once and in order, the question once,
 *      the answer reaches the agent once, the prompt reached it once, the same agent process, the same keeper process. B is on A's
 *      port, so a localStorage key A's page wrote (through the WebView2 DevTools port) is still there; the page session A's window
 *      held in memory (never in localStorage) gets the page token from B (only its hash is on disk), and B's own window is handed a
 *      one-time key of B's and connects with a session of its own (the test's AIB_PAGE_KEY reaches only A).
 *   5. The agent's artifact tool is the keeper's MCP forwarder (`AIB-keeper mcp-forward`, run from the data folder's keeper-bin),
 *      never A's AIB.exe, so B removes the update's .old-* files at its start while the chat still runs.
 *   6. B is killed hard mid-turn: the keeper starts AIB again with --start-in-tray (rule V1): no window, only the tray icon (Open AIB,
 *      a status line, Quit AIB, Stop all chats and quit); the turn goes on there, and once nothing works the tray-only AIB quits by itself, which
 *      leaves no process behind: no AIB, no keeper, no agent, no forwarder.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, httpJson, nativePath, PAGE_KEY, until, within } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { WORK } from './_work.ts';
import { pidAlive, readInfo } from '../../app/server/host/host_client.ts';
import { devToolsPortNow, ownerPort, pickPort } from './_ports.ts';
import { builtDist, NEXT_VERSION } from './_build_cache.ts';
import { APP_VERSION } from '../../app/server/core/app.ts';
import { KeeperClient, type KeeperRecord, readKeeperInfo } from '../../app/server/keeper/client.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
/** OS-chosen (after the builds), port + 1 free: B comes back on the port A used (desktop-port.json). */
let PORT = 0;
const NEXT = NEXT_VERSION; // one B for every update test: one cached build
const CHUNKS = 40;
const WATCHDOG_MIN = 15;
type Json = Record<string, unknown>;
const KEEPER_AGENT = nativePath(new URL('keeper-fixture/agent.mjs', WORK));
const DEC = new TextDecoder();
/** The app folder: WebView2 keeps its profile next to the exe (AIB.exe.WebView2); its DevToolsActivePort names the CDP port, new
 * after every restart. */
let cdpRoot = '';

/** Run `expression` in AIB's page (the window's WebView2, through its DevTools port). */
function cdpEval(expression: string): Promise<unknown> {
  // Every step waits on WebView2 (HTTP, then a socket that may open and never answer, or close without a reply): bounded as a whole.
  return within(cdpEvalUnbounded(expression), 10_000, 'the page (WebView2 DevTools) to answer');
}

async function cdpEvalUnbounded(expression: string): Promise<unknown> {
  const cdp = devToolsPortNow(cdpRoot);
  if (!cdp) throw new Error('no DevToolsActivePort yet');
  const targets = await (await fetch(`http://127.0.0.1:${cdp}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as Json[];
  const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(`http://127.0.0.1:${PORT}`));
  if (!page) throw new Error('no page target yet');
  const ws = new WebSocket(String(page.webSocketDebuggerUrl));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const answer = new Promise<Json>((resolve, reject) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.onclose = () => reject(new Error('DevTools socket closed without an answer'));
    });
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
  const child = new Deno.Command('powershell', { args: ['-NoProfile', '-NonInteractive', '-Command', script], stdout: 'piped' }).spawn();
  const killer = setTimeout(() => {
    try {
      child.kill('SIGKILL'); // our own child only
    } catch { /* gone */ }
  }, 30_000);
  const r = await child.output().finally(() => clearTimeout(killer));
  if (!r.success) throw new Error('process listing (powershell) failed or took over 30 s');
  return DEC.decode(r.stdout).split(/\r?\n/).filter(Boolean).map((l) => {
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
      const asset = (name: string, url: string): Json => ({
        name,
        state: 'uploaded',
        size: Deno.statSync(`${dist}\\${name}`).size,
        url: base + url,
      });
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

/**
 * GET /api/live/bootstrap as AIB's page asks after a restart: with the page session its origin keeps (page-auth.js), not the launch
 * key. Only A was started with the test's AIB_PAGE_KEY; outside a test run AIB drops that variable at start, so the update helper,
 * B and the keeper's restart never inherit it, and each has a launch key of its own (page_access.ts). The page session is what
 * carries the page across an update.
 */
async function bootstrapWithSession(session: string): Promise<[number, Json]> {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/live/bootstrap`, {
    headers: { 'X-AIB-Page-Session': session },
    signal: AbortSignal.timeout(3000),
  });
  const text = await response.text();
  return [response.status, text ? JSON.parse(text) : {}];
}

function said(state: Json): string {
  return ((state.events ?? []) as Json[]).filter((e) => e.kind === 'update').map((e) => {
    const update = (e.data as Json).update as Json;
    return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
  }).join('');
}

/** A client of the keeper in `state`, bounded: a keeper that accepts and never answers fails the test instead of hanging it. */
function keeperConnect(state: string): Promise<KeeperClient> {
  return within(KeeperClient.connect(readKeeperInfo(state)!, 'keeper e2e test'), 15_000, 'the keeper to answer a new client');
}

/** The keeper's whole record of one channel, read through a client of our own (attaching never claims). */
async function journal(state: string, channel: string): Promise<KeeperRecord[]> {
  const client = await keeperConnect(state);
  const records: KeeperRecord[] = [];
  let live = false;
  try {
    await client.attach(channel, 0, { record: (r) => records.push(r), live: () => (live = true) });
    await until(() => live, 'journal read', 10);
    return records;
  } finally {
    client.close();
  }
}

const sentLines = (records: KeeperRecord[]) =>
  records.filter((r) => r.kind === 'in').flatMap((r) => DEC.decode(r.body).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));

Deno.test({
  name: 'real binaries, keeper on: Install now mid-turn; the new version takes the chat over from the keeper, nothing lost or repeated',
  ignore: !SLOW,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using fx = new Fixture();
    const install = `${fx.root}\\install`;
    const agentLog = `${fx.root}\\agent-received.log`;
    const mcpPids = `${fx.root}\\mcp-pids.txt`;
    const trays = `${fx.root}\\trays`;
    Deno.mkdirSync(trays);
    const started = Date.now();
    const [distA, distB] = await Promise.all([builtDist(), builtDist(NEXT)]); // built once per source, shared (_build_cache.ts)
    console.log(`builds: ${((Date.now() - started) / 1000).toFixed(0)} s`);
    Deno.mkdirSync(install);
    const tar = await new Deno.Command('C:\\Windows\\System32\\tar.exe', {
      args: ['-xf', `${distA}\\AIB-${APP_VERSION}-windows-x64.zip`, '-C', install],
    }).output();
    assert(tar.success, 'unzip A');
    const info = JSON.parse(Deno.readTextFileSync(`${distB}\\release.json`));
    assertEquals(info.keeper, { protocols: [1], needs: ['notes', 'once', 'channel-ids'] }, 'B says what it needs of a keeper');
    const app = `${install}\\AIB`;
    const exe = `${app}\\AIB.exe`;
    assert(Deno.statSync(`${app}\\AIB-keeper.exe`).isFile, 'A ships its keeper');
    const releases = fakeReleases(distB);
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    const env: Record<string, string> = {
      AGENT_STUDIO_STATE_DIR: fx.state,
      AIB_PAGE_KEY: PAGE_KEY, // bootstrap gives the token only with the launch key (web/page_access.ts)
      APPDATA: `${fx.root}\\appdata`,
      LOCALAPPDATA: `${fx.root}\\localappdata`,
      AIB_UPDATE_API_BASE: `http://127.0.0.1:${releases.addr.port}`,
      AIB_UPDATE_REPO: 'acme/aib',
      FAKE_ACP_LOG: agentLog,
      FAKE_ACP_MCP_PIDS: mcpPids, // the fake agent starts its stdio MCP servers like a real agent
      AIB_TEST_TRAY_STATE: trays,
      AIB_TEST_CLOSE_HANG: '1', // A's quit for the update has a step that never returns: the 10 s bound ends it (main.ts close)
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1', // the built app cannot see work/, so its test guard is told the agent is the fake one
      AIB_TEST_FIXTURE_ROOT: nativePath(new URL('keeper-fixture/', WORK)), // and its test auth guard: only programs in this folder are fakes
    };
    for (const d of [env.APPDATA, env.LOCALAPPDATA]) Deno.mkdirSync(d, { recursive: true });
    cdpRoot = app;
    PORT = pickPort(true);
    Deno.writeTextFileSync(`${fx.state}\\desktop-port.json`, JSON.stringify({ port: PORT }));
    const pids = new Set<number>();
    let keeperPid = 0;
    // Backstop: the whole test (after the builds) must end in WATCHDOG_MIN minutes. Past that, something waits on a promise that never
    // settles; stop the processes this test started and end the run with a message instead of sitting there for hours.
    const watchdog = setTimeout(() => {
      console.error(`keeper_update_e2e: HUNG, still running ${WATCHDOG_MIN} minutes after the builds; killing the processes it started and exiting`);
      for (const pid of [...pids, keeperPid]) {
        if (pid) {
          try {
            Deno.kill(pid, 'SIGKILL');
          } catch { /* gone */ }
        }
      }
      setTimeout(() => Deno.exit(1), 3000);
    }, WATCHDOG_MIN * 60_000);
    try {
      for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
      const flags = fx.agentFlags().filter((_, i, a) => a[i] !== '--state-dir' && a[i - 1] !== '--state-dir');
      flags[flags.indexOf('--claude-launcher') + 1] = KEEPER_AGENT;
      const aPid = desk.spawn([exe, ...flags], app);
      PORT = await ownerPort(fx.state, 90); // the port A really bound: if another process took the saved one first, A picked and saved another, and B must come back on that
      pids.add(aPid);
      for (const k of Object.keys(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);

      // ---- A: one process with the keeper; a chat streams
      const bootA = await until(
        async () => {
          const [s, b] = await httpJson('GET', PORT, '/api/live/bootstrap', null, undefined, 3000);
          return s === 200 ? b : null;
        },
        'A on the saved port',
        90,
      );
      const tokenA = String(bootA.token);
      assertEquals(bootA.hostMode, 'keeper', 'one AIB process; agents in the keeper');
      assertEquals(await readInfo(fx.state), null, 'no separate agent host');
      await until(() => cdpEval(`localStorage.setItem('aib-e2e-draft', 'kept across the update'), 'ok'`), 'localStorage write', 60);
      // The page session A's window traded its one-time launch key for (page-auth.js, in the page's memory only): only its hash is
      // on disk, so B and the keeper's restart give the token for it too.
      const pageSession = String(
        await until(() => cdpEval(`window.AIBPageAuth ? AIBPageAuth.state().session : ''`), "the page session of A's window", 60),
      );
      assertEquals(await cdpEval(`localStorage.getItem('aib-page-session')`), null, 'never in localStorage');
      const post = (token: string, name: string, body: unknown) => httpJson('POST', PORT, '/api/live/' + name, token, body);
      const [cs, conn] = await post(tokenA, 'connect', { provider: 'claude', cwd: fx.workspace, background: true });
      assertEquals(cs, 200, JSON.stringify(conn));
      const cid = String(conn.id);
      const channel = `chat-${cid}`;
      const state = async (token: string) => (await httpJson('GET', PORT, `/api/live/state?id=${cid}`, token))[1];
      await until(async () => (await state(tokenA)).ready, 'chat ready', 60);
      const keeperInfo = readKeeperInfo(fx.state)!;
      keeperPid = keeperInfo.pid;
      pids.add(keeperPid);
      const keeperExe = (await processesUnder(fx.state)).find(([pid]) => pid === keeperPid)?.[1] ?? '';
      assert(
        /\\keeper-bin\\[0-9a-f]{16}\\AIB-keeper\.exe$/i.test(keeperExe),
        `the keeper runs from the data folder, not the app folder: ${keeperExe}`,
      );
      const watcher = await keeperConnect(fx.state);
      const agentPid = (await within(watcher.list(), 15_000, 'the keeper to list its chats')).find((c) => c.channel === channel)!.pid;
      watcher.close();
      pids.add(agentPid);
      assertEquals((await post(tokenA, 'prompt', { id: cid, text: `stream:${CHUNKS}:150`, clientMessageId: 'k2-e2e' }))[0], 200);
      await until(async () => said(await state(tokenA)).includes('chunk2 '), 'streaming on A', 20);

      // ---- Install now mid-turn
      await post(tokenA, 'update/check', {});
      await until(async () => (await httpJson('GET', PORT, '/api/live/update', tokenA))[1].state === 'ready', 'update ready', 120);
      const before = said(await state(tokenA));
      assert(!before.includes(`chunk${CHUNKS - 1} `), 'still mid-turn when Install now is clicked');
      const [is, installing] = await post(tokenA, 'update/install', {});
      assertEquals([is, installing.state, installing.chats], [200, 'installing', 1], JSON.stringify(installing));
      // A second click (the owner clicked twice) starts no second helper and answers that the update is in progress.
      const clicked = Date.now();
      const [is2, installing2] = await post(tokenA, 'update/install', {});
      assertEquals([is2, installing2.state], [200, 'installing'], JSON.stringify(installing2));
      // A's quit hangs forever in this run (AIB_TEST_CLOSE_HANG): it still ends within its 10 s bound, the helper never has to kill it.
      await until(() => !pidAlive(aPid), 'A quit', 60);
      const quitSeconds = (Date.now() - clicked) / 1000;
      assert(quitSeconds < 25, `A quit within its bound although a step hung (${quitSeconds} s)`);
      assert(pidAlive(keeperPid), 'the keeper outlived A');
      assert(pidAlive(agentPid), 'the agent outlived A');

      // ---- B takes the chat over
      const bootB = await until(
        async () => {
          const [s, b] = await bootstrapWithSession(pageSession);
          return s === 200 && b.token && b.token !== tokenA ? b : null;
        },
        'B on the same port, giving the page the token for its page session',
        180,
      );
      const tokenB = String(bootB.token);
      pids.add(JSON.parse(Deno.readTextFileSync(`${fx.state}\\aib-owner.json`)).pid);
      assertEquals((await httpJson('GET', PORT, '/api/live/update', tokenB))[1].current, NEXT, 'B runs');
      assertEquals([bootB.hostMode, bootB.instanceId], ['keeper', bootA.instanceId], 'same instance: open pages keep the chat');
      const asked = await until(
        async () => {
          const s = await state(tokenB);
          return s.id === cid && s.ready && (s.permissions as Json[]).length === 1 ? s : null;
        },
        'the question on B',
        60,
      );
      assertEquals(asked.error, '');
      assert(asked.busy, 'the turn is still running');
      assertEquals((asked.events as Json[]).filter((e) => e.kind === 'permission').length, 1, 'the question shows once');
      assertEquals((asked.events as Json[]).filter((e) => e.kind === 'user').length, 1, 'the prompt shows once');
      const key = (asked.permissions as Json[])[0].key;
      assertEquals((await post(tokenB, 'permission', { id: cid, key, option: 'yes' }))[0], 200);
      const done = await until(
        async () => {
          const s = await state(tokenB);
          return !s.busy ? s : null;
        },
        'turn end on B',
        60,
      );
      const expected = Array.from({ length: CHUNKS }, (_, i) => (i === CHUNKS / 2 ? 'answer=yes ' : '') + `chunk${i} `).join('');
      assertEquals(said(done), expected, 'every chunk once, in order, across the update');
      assertEquals((done.events as Json[]).filter((e) => e.kind === 'turn_end').length, 1);

      // Exactly once at the agent, and in the keeper's record of what AIB wrote; the same processes.
      const received = Deno.readTextFileSync(agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      assertEquals(received.filter((m) => m.method === 'session/prompt').length, 1, 'the prompt reached the agent once');
      assertEquals(received.filter((m) => m.id === 'stream-ask' && !m.method).length, 1, 'the answer reached the agent once');
      const sent = sentLines(await journal(fx.state, channel));
      assertEquals(sent.filter((m) => m.method === 'session/prompt').length, 1);
      assertEquals(sent.filter((m) => m.id === 'stream-ask' && !m.method).length, 1);
      const now = await keeperConnect(fx.state);
      const after = (await within(now.list(), 15_000, 'the keeper to list its chats')).find((c) => c.channel === channel)!;
      now.close();
      assertEquals([after.live, after.pid], [true, agentPid], 'the same agent process');
      assertEquals(readKeeperInfo(fx.state)!.pid, keeperPid, 'the same keeper process, kept running across the update');
      const installLog = Deno.readTextFileSync(`${fx.state}\\updates\\install.log`);
      assertEquals(installLog.split('waiting for the app').length - 1, 1, 'one helper only (the double click started no second one)');
      assert(!installLog.includes('ended it'), 'the app quit by itself within its bound; the helper did not have to end it');
      assert(installLog.includes('staying connected to the keeper'), installLog);
      assert(installLog.includes('the new version is running (it confirmed its start)'), installLog);
      assert([...Deno.readDirSync(trays)].some((e) => e.name.startsWith('helper-')), 'the update helper showed a tray icon');
      assertEquals(await until(() => cdpEval(`localStorage.getItem('aib-e2e-draft')`), 'localStorage read on B', 60), 'kept across the update');
      // B reconnects its window: the new page is handed a one-time key of B's and has a page session of its own.
      const sessionB = String(
        await until(
          async () => {
            const s = String(await cdpEval(`window.AIBPageAuth ? AIBPageAuth.state().session : ''`) ?? '');
            return s && s !== pageSession ? s : null;
          },
          "B's window connected with a key of its own",
          60,
        ),
      );
      assertEquals((await bootstrapWithSession(sessionB))[1].token, tokenB, "B's window gets the token");
      const aibLog = Deno.readTextFileSync(`${fx.state}\\studio.log`);
      assert(aibLog.includes('closing (installing an update); leaving the chats in the keeper'), aibLog.slice(-3000));
      assert(aibLog.includes('released 1 chat(s) to the keeper'), aibLog.slice(-3000));
      assert(aibLog.includes('closing: a step did not finish within 10 s; exiting now'), aibLog.slice(-3000));
      assert(aibLog.includes('keeper: 1 chat(s) taken over from the keeper'), aibLog.slice(-3000));

      // ---- the artifact tool is the keeper's forwarder, so B removed the update's leftovers although the chat runs
      const [mcpLine] = Deno.readTextFileSync(mcpPids).split('\n').filter((l) => l.trim());
      const [mcpPid, mcpName, ...mcpCommand] = mcpLine.trim().split(' ');
      pids.add(Number(mcpPid));
      assertEquals(mcpName, 'studio_artifact');
      assert(
        /\\keeper-bin\\[0-9a-f]{16}\\AIB-keeper\.exe$/i.test(mcpCommand.join(' ')),
        `the forwarder runs from the data folder: ${mcpCommand.join(' ')}`,
      );
      assert(pidAlive(Number(mcpPid)), 'the forwarder still runs for the chat');
      assertEquals((await processesUnder(install)).filter(([pid]) => pid === Number(mcpPid)), [], 'nothing of the agent runs from the app');
      await until(
        () => [...Deno.readDirSync(app)].every((e) => !/\.old-/.test(e.name)),
        `B removed the .old-* files while the chat runs (${[...Deno.readDirSync(app)].map((e) => e.name).join(', ')})`,
        30,
      );

      // ---- kill B mid-turn: the keeper starts AIB again in the tray, with no window
      const bPid = JSON.parse(Deno.readTextFileSync(`${fx.state}\\aib-owner.json`)).pid;
      assertEquals((await post(tokenB, 'prompt', { id: cid, text: 'stream:30:150', clientMessageId: 'k2-e2e-2' }))[0], 200);
      await until(async () => said(await state(tokenB)).includes('chunk2 chunk3 '), 'second turn streaming on B', 20);
      Deno.kill(bPid, 'SIGKILL');
      await until(() => !pidAlive(bPid), 'B gone', 10);
      const bootC = await until(
        async () => {
          const [s, b] = await bootstrapWithSession(pageSession);
          return s === 200 && b.token && b.token !== tokenB ? b : null;
        },
        'AIB started again by the keeper, giving the page the token for its page session',
        60,
      );
      const tokenC = String(bootC.token);
      const cPid = JSON.parse(Deno.readTextFileSync(`${fx.state}\\aib-owner.json`)).pid;
      pids.add(cPid);
      assertEquals(bootC.instanceId, bootA.instanceId, 'the same instance: an open page keeps the chat');
      const tray = await until(
        () => {
          try {
            const t = JSON.parse(Deno.readTextFileSync(`${trays}\\app-${cPid}.json`));
            return t.shown && t.status ? t : null;
          } catch {
            return null;
          }
        },
        'the tray-only icon',
        30,
      );
      assertEquals([tray.trayOnly, tray.windowOpened], [true, false]);
      assertEquals([tray.items[0], tray.items[2], tray.items[3]], ['Open AIB', 'Quit AIB', 'Stop all chats and quit']);
      for (let i = 0; i < 6; i++) { // over a few seconds: no window of the restarted AIB ever shows
        // Windows' own per-process input windows (the UAC input indicator overlay, IME) are not AIB's and never show on screen.
        const shown = desk.windows().filter((w) => w.pid === cPid && w.visible && !/^(UAC|IME$|MSCTFIME UI$|Default IME$)/.test(w.cls));
        assertEquals(shown.map((w) => `${w.title} ${w.cls}`), [], 'the keeper\'s restart shows no window');
        await new Promise((r) => setTimeout(r, 500));
      }
      const asked2 = await until(
        async () => {
          const st = await state(tokenC);
          return st.id === cid && st.ready && (st.permissions as Json[]).length === 1 ? st : null;
        },
        'the second question on the tray-only AIB',
        60,
      );
      assertEquals((await post(tokenC, 'permission', { id: cid, key: (asked2.permissions as Json[])[0].key, option: 'yes' }))[0], 200);
      await until(async () => !(await state(tokenC)).busy, 'second turn end', 60);
      const received2 = Deno.readTextFileSync(agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      assertEquals(received2.filter((m) => m.method === 'session/prompt').length, 2, 'each prompt reached the agent once');

      // ---- nothing works any more: the tray-only AIB quits by itself and leaves no process behind
      await until(async () => (await processesUnder(install)).length === 0, 'the tray-only AIB quit by itself', 60);
      await until(() => !pidAlive(agentPid), 'the agent ended', 15);
      await until(() => !pidAlive(Number(mcpPid)), 'the forwarder ended with the agent', 15);
      await until(() => !pidAlive(keeperPid), 'the keeper exited (no channel, no client)', 30);
      assertEquals(await processesUnder(fx.state), [], 'nothing runs from the data folder');
    } finally {
      clearTimeout(watchdog);
      for (const [k] of Object.entries(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
      // The keeper first: with a live chat and no client it would start AIB again (its orphan command).
      if (keeperPid && pidAlive(keeperPid)) {
        try {
          Deno.kill(keeperPid, 'SIGKILL');
        } catch { /* gone */ }
      }
      for (const [pid] of await processesUnder(install).catch(() => [] as [number, string][])) pids.add(pid);
      for (const [pid] of await processesUnder(fx.state).catch(() => [] as [number, string][])) pids.add(pid);
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
