/**
 * Keeper step 2 with real binaries, end to end (slow: two `deno desktop` builds; AIB_SLOW_TESTS=1, Windows only): Install now while a
 * chat streams, with the keeper on (the default: no setting, no AIB_KEEPER; one AIB process). Everything runs on an invisible desktop (_hidden_desktop.ts) with
 * a temp data folder, temp APPDATA/LOCALAPPDATA and ports 8821/8822; only processes this test started are killed.
 *
 *   1. Build AIB at APP_VERSION (A) and at 0.1.0-beta.98 (B), each with its keeper; install A from its zip into a temp folder.
 *   2. Start A (no --port: it reuses desktop-port.json). One process, no agent host (hostMode 'keeper'). A chat with the fake agent
 *      (work/keeper-fixture/agent.py) streams 40 chunks, 150 ms apart, and asks a question after chunk 19.
 *   3. Check for updates against a local fake GitHub releases API serving B (zip, SHA256SUMS, release.json) and click Install now
 *      mid-turn: A leaves the chat in the keeper and quits, the update helper stays connected to the keeper while it swaps the files,
 *      starts B and waits for B's start confirmation.
 *   4. B takes the chat over from the keeper's record under the same connection id: every chunk once and in order, the question once,
 *      the answer reaches the agent once, the prompt reached it once, the same agent process, the same keeper process.
 *   5. The agent's artifact tool is the keeper's MCP forwarder (`AIB-keeper mcp-forward`, run from the data folder's keeper-bin),
 *      never A's AIB.exe, so B removes the update's .old-* files at its start while the chat still runs.
 *   6. B is killed hard mid-turn: the keeper starts AIB again with --start-in-tray (rule V1): no window, only the tray icon (Open AIB,
 *      a status line, Stop chats and quit); the turn goes on there, and once nothing works the tray-only AIB quits by itself, which
 *      leaves no process behind: no AIB, no keeper, no agent, no forwarder.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, httpJson, nativePath, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { WORK } from './_parity.ts';
import { pidAlive, readInfo } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_VERSION, REPO_ROOT } from '../../outputs/agent-studio/server/core/app.ts';
import { KeeperClient, type KeeperRecord, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
const PORT = 8821;
const NEXT = '0.1.0-beta.98';
const CHUNKS = 40;
type Json = Record<string, unknown>;
const KEEPER_AGENT = nativePath(new URL('keeper-fixture/agent.py', WORK));
const DEC = new TextDecoder();

async function build(out: string, version?: string): Promise<void> {
  const args = ['run', '-A', `${REPO_ROOT}\\tools\\build.ts`, '--targets', 'windows-x64', '--out', out, '--no-smoke'];
  if (version) args.push('--version', version);
  const r = await new Deno.Command(Deno.execPath(), { args, stdout: 'piped', stderr: 'piped' }).output();
  if (!r.success) throw new Error(`build failed: ${DEC.decode(r.stderr)}`);
}

/** Every process whose program is under `folder` (Win32_Process), as [pid, path]. */
async function processesUnder(folder: string): Promise<[number, string][]> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${
    folder.replaceAll("'", "''")
  }', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
  const r = await new Deno.Command('powershell', { args: ['-NoProfile', '-NonInteractive', '-Command', script], stdout: 'piped' }).output();
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

function said(state: Json): string {
  return ((state.events ?? []) as Json[]).filter((e) => e.kind === 'update').map((e) => {
    const update = (e.data as Json).update as Json;
    return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
  }).join('');
}

/** The keeper's whole record of one channel, read through a client of our own (attaching never claims). */
async function journal(state: string, channel: string): Promise<KeeperRecord[]> {
  const client = await KeeperClient.connect(readKeeperInfo(state)!, 'keeper e2e test');
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
    const distA = `${fx.root}\\distA`, distB = `${fx.root}\\distB`, install = `${fx.root}\\install`;
    const agentLog = `${fx.root}\\agent-received.log`;
    const mcpPids = `${fx.root}\\mcp-pids.txt`;
    const trays = `${fx.root}\\trays`;
    Deno.mkdirSync(trays);
    const started = Date.now();
    await Promise.all([build(distA), build(distB, NEXT)]);
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
      APPDATA: `${fx.root}\\appdata`,
      LOCALAPPDATA: `${fx.root}\\localappdata`,
      AIB_UPDATE_API_BASE: `http://127.0.0.1:${releases.addr.port}`,
      AIB_UPDATE_REPO: 'acme/aib',
      FAKE_ACP_LOG: agentLog,
      FAKE_ACP_MCP_PIDS: mcpPids, // the fake agent starts its stdio MCP servers like a real agent
      AIB_TEST_TRAY_STATE: trays,
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1', // the built app cannot see work/, so its test guard is told the agent is the fake one
    };
    for (const d of [env.APPDATA, env.LOCALAPPDATA]) Deno.mkdirSync(d, { recursive: true });
    Deno.writeTextFileSync(`${fx.state}\\desktop-port.json`, JSON.stringify({ port: PORT }));
    const pids = new Set<number>();
    let keeperPid = 0;
    try {
      for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
      const flags = fx.agentFlags().filter((_, i, a) => a[i] !== '--state-dir' && a[i - 1] !== '--state-dir');
      flags[flags.indexOf('--claude-launcher') + 1] = KEEPER_AGENT;
      const aPid = desk.spawn([exe, ...flags], app);
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
      const watcher = await KeeperClient.connect(keeperInfo, 'keeper e2e test');
      const agentPid = (await watcher.list()).find((c) => c.channel === channel)!.pid;
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
      await until(() => !pidAlive(aPid), 'A quit', 60);
      assert(pidAlive(keeperPid), 'the keeper outlived A');
      assert(pidAlive(agentPid), 'the agent outlived A');

      // ---- B takes the chat over
      const bootB = await until(
        async () => {
          const [s, b] = await httpJson('GET', PORT, '/api/live/bootstrap', null, undefined, 3000);
          return s === 200 && b.token !== tokenA ? b : null;
        },
        'B on the same port',
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
      const now = await KeeperClient.connect(readKeeperInfo(fx.state)!, 'keeper e2e test');
      const after = (await now.list()).find((c) => c.channel === channel)!;
      now.close();
      assertEquals([after.live, after.pid], [true, agentPid], 'the same agent process');
      assertEquals(readKeeperInfo(fx.state)!.pid, keeperPid, 'the same keeper process, kept running across the update');
      const installLog = Deno.readTextFileSync(`${fx.state}\\updates\\install.log`);
      assert(installLog.includes('staying connected to the keeper'), installLog);
      assert(installLog.includes('the new version is running (it confirmed its start)'), installLog);
      const studioLog = Deno.readTextFileSync(`${fx.state}\\studio.log`);
      assert(studioLog.includes('closing (installing an update); leaving the chats in the keeper'), studioLog.slice(-3000));
      assert(studioLog.includes('released 1 chat(s) to the keeper'), studioLog.slice(-3000));
      assert(studioLog.includes('keeper: 1 chat(s) taken over from the keeper'), studioLog.slice(-3000));

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
          const [s, b] = await httpJson('GET', PORT, '/api/live/bootstrap', null, undefined, 3000);
          return s === 200 && b.token !== tokenB ? b : null;
        },
        'AIB started again by the keeper',
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
      assertEquals([tray.items[0], tray.items[2]], ['Open AIB', 'Stop chats and quit']);
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
