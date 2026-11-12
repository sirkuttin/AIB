/**
 * Quit with chats working, then start AIB again from a fresh zip in another folder: the owner's manual-update flow, with real binaries
 * end to end (slow: two `deno desktop` builds; AIB_SLOW_TESTS=1, Windows only). Owner's decision 2026-11-11: quitting AIB while chats
 * work does exactly what Install now does; AIB.exe exits, the keeper holds the chats, and the next AIB.exe started (the same build or
 * a new one unzipped elsewhere) takes them over. Everything runs on an invisible desktop (_hidden_desktop.ts) with a temp data folder,
 * temp APPDATA/LOCALAPPDATA and port 8823; only processes this test started are killed.
 *
 *   1. Build AIB at APP_VERSION (A) and at 0.1.0-beta.97 (B), each with its keeper; unzip A into one folder and B into another.
 *   2. Start A. A chat with the fake agent (work/keeper-fixture/agent.py) streams 40 chunks, 300 ms apart, and asks a question
 *      halfway.
 *   3. Close A's window mid-turn (WM_CLOSE: the person's close button): A leaves the chat in the keeper and exits. AIB.exe is gone;
 *      the keeper says it holds the chat, the agent goes on (the question arrives, the keeper records it), and the keeper does NOT
 *      start AIB again (no AIB process appears for longer than its orphan restart would take).
 *   4. Start B from its own folder on the same data folder: it takes the chat over from the keeper's record under the same instance
 *      id: every chunk once and in order, the question once, the answer reaches the agent once, the prompt reached it once, the same
 *      agent process, the same keeper process.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, httpJson, nativePath, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { WORK } from './_parity.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_VERSION, REPO_ROOT } from '../../outputs/agent-studio/server/core/app.ts';
import { KeeperClient, type KeeperRecord, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';

const SLOW = Deno.build.os === 'windows' &&
  Deno.env.get('AIB_SLOW_TESTS') === '1';
const PORT = 8823;
const NEXT = '0.1.0-beta.97';
const CHUNKS = 40;
const WM_CLOSE = 0x0010;
type Json = Record<string, unknown>;
const KEEPER_AGENT = nativePath(new URL('keeper-fixture/agent.py', WORK));
const DEC = new TextDecoder();

async function build(out: string, version?: string): Promise<void> {
  const args = [
    'run',
    '-A',
    `${REPO_ROOT}\\tools\\build.ts`,
    '--targets',
    'windows-x64',
    '--out',
    out,
    '--no-smoke',
  ];
  if (version) args.push('--version', version);
  const r = await new Deno.Command(Deno.execPath(), {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!r.success) throw new Error(`build failed: ${DEC.decode(r.stderr)}`);
}

async function unzip(zip: string, into: string): Promise<void> {
  Deno.mkdirSync(into, { recursive: true });
  const r = await new Deno.Command('C:\\Windows\\System32\\tar.exe', {
    args: ['-xf', zip, '-C', into],
  }).output();
  assert(r.success, `unzip ${zip}`);
}

/** Every process whose program is under `folder` (Win32_Process), as [pid, path]. */
async function processesUnder(folder: string): Promise<[number, string][]> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${
    folder.replaceAll("'", "''")
  }', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
  const r = await new Deno.Command('powershell', {
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    stdout: 'piped',
  }).output();
  return DEC.decode(r.stdout).split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, path] = l.split('|');
    return [Number(pid), path];
  });
}

function said(state: Json): string {
  return ((state.events ?? []) as Json[]).filter((e) => e.kind === 'update')
    .map((e) => {
      const update = (e.data as Json).update as Json;
      return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
    }).join('');
}

/** The keeper's whole record of one channel, read through a client of our own (attaching never claims). */
async function journal(
  state: string,
  channel: string,
): Promise<KeeperRecord[]> {
  const client = await KeeperClient.connect(
    readKeeperInfo(state)!,
    'keeper e2e test',
  );
  const records: KeeperRecord[] = [];
  let live = false;
  try {
    await client.attach(channel, 0, {
      record: (r) => records.push(r),
      live: () => (live = true),
    });
    await until(() => live, 'journal read', 10);
    return records;
  } finally {
    client.close();
  }
}

const sentLines = (records: KeeperRecord[]) =>
  records.filter((r) => r.kind === 'in').flatMap((r) => DEC.decode(r.body).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
const outText = (records: KeeperRecord[]) =>
  records.filter((r) => r.kind === 'out').map((r) => DEC.decode(r.body)).join(
    '',
  );

function keeperJson(state: string): Json {
  return JSON.parse(Deno.readTextFileSync(`${state}\\keeper\\keeper.json`));
}

Deno.test({
  name: 'real binaries: quit mid-turn, AIB.exe exits and the keeper holds the chat; a new build from another folder takes it over',
  ignore: !SLOW,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using fx = new Fixture();
    const distA = `${fx.root}\\distA`, distB = `${fx.root}\\distB`;
    const installA = `${fx.root}\\installA`, installB = `${fx.root}\\installB`;
    const agentLog = `${fx.root}\\agent-received.log`;
    const started = Date.now();
    await Promise.all([build(distA), build(distB, NEXT)]);
    console.log(`builds: ${((Date.now() - started) / 1000).toFixed(0)} s`);
    await unzip(`${distA}\\AIB-${APP_VERSION}-windows-x64.zip`, installA);
    await unzip(`${distB}\\AIB-${NEXT}-windows-x64.zip`, installB);
    const appA = `${installA}\\AIB`, appB = `${installB}\\AIB`;
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    const env: Record<string, string> = {
      AGENT_STUDIO_STATE_DIR: fx.state,
      APPDATA: `${fx.root}\\appdata`,
      LOCALAPPDATA: `${fx.root}\\localappdata`,
      AIB_UPDATE_API_BASE: 'http://127.0.0.1:9', // no update check reaches anything
      FAKE_ACP_LOG: agentLog,
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1', // the built app cannot see work/, so its test guard is told the agent is the fake one
    };
    for (const d of [env.APPDATA, env.LOCALAPPDATA]) {
      Deno.mkdirSync(d, { recursive: true });
    }
    Deno.writeTextFileSync(
      `${fx.state}\\desktop-port.json`,
      JSON.stringify({ port: PORT }),
    );
    const pids = new Set<number>();
    let keeperPid = 0;
    const flags = fx.agentFlags().filter((_, i, a) => a[i] !== '--state-dir' && a[i - 1] !== '--state-dir');
    flags[flags.indexOf('--claude-launcher') + 1] = KEEPER_AGENT;
    const spawn = (exe: string, cwd: string) => {
      try {
        for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
        return desk.spawn([exe, ...flags], cwd);
      } finally {
        for (const k of Object.keys(env)) {
          saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
        }
      }
    };
    try {
      // ---- A: a chat streams
      const aPid = spawn(`${appA}\\AIB.exe`, appA);
      pids.add(aPid);
      const bootA = await until(
        async () => {
          const [s, b] = await httpJson(
            'GET',
            PORT,
            '/api/live/bootstrap',
            null,
            undefined,
            3000,
          );
          return s === 200 ? b : null;
        },
        'A on the saved port',
        90,
      );
      const tokenA = String(bootA.token);
      assertEquals(
        bootA.hostMode,
        'keeper',
        'one AIB process; agents in the keeper',
      );
      const post = (token: string, name: string, body: unknown) => httpJson('POST', PORT, '/api/live/' + name, token, body);
      const [cs, conn] = await post(tokenA, 'connect', {
        provider: 'claude',
        cwd: fx.workspace,
        background: true,
      });
      assertEquals(cs, 200, JSON.stringify(conn));
      const cid = String(conn.id);
      const channel = `chat-${cid}`;
      const state = async (token: string) => (await httpJson('GET', PORT, `/api/live/state?id=${cid}`, token))[1];
      await until(async () => (await state(tokenA)).ready, 'chat ready', 60);
      keeperPid = readKeeperInfo(fx.state)!.pid;
      pids.add(keeperPid);
      const watcher = await KeeperClient.connect(
        readKeeperInfo(fx.state)!,
        'keeper e2e test',
      );
      const agentPid = (await watcher.list()).find((c) => c.channel === channel)!.pid;
      watcher.close();
      pids.add(agentPid);
      assertEquals(
        (await post(tokenA, 'prompt', {
          id: cid,
          text: `stream:${CHUNKS}:300`,
          clientMessageId: 'quit-e2e',
        }))[0],
        200,
      );
      await until(
        async () => said(await state(tokenA)).includes('chunk2 '),
        'streaming on A',
        20,
      );

      // ---- the person closes A's window mid-turn
      const win = await until(
        () => desk.windows().find((w) => w.pid === aPid && w.visible && w.title === 'AIB') ?? null,
        "A's window",
        30,
      );
      assert(
        !said(await state(tokenA)).includes(`chunk${CHUNKS / 2} `),
        'still mid-turn, before the question',
      );
      assert(desk.post(win, WM_CLOSE), 'WM_CLOSE posted');
      await until(
        () => !pidAlive(aPid),
        'A exited (AIB.exe is gone, not waiting in the tray)',
        60,
      );
      assert(
        pidAlive(keeperPid) && pidAlive(agentPid),
        'the keeper and the agent outlived A',
      );
      assertEquals(
        keeperJson(fx.state).held,
        true,
        'the keeper holds the chat for the next AIB',
      );
      const studioLog = Deno.readTextFileSync(`${fx.state}\\studio.log`);
      assert(
        studioLog.includes(
          'closing (the app was quit with work running); the keeper holds the chats',
        ),
        studioLog.slice(-3000),
      );
      assert(
        studioLog.includes('released 1 chat(s) to the keeper'),
        studioLog.slice(-3000),
      );

      // ---- no AIB runs: the agent goes on and the keeper records it; nobody starts AIB again (rule V1 would after 5 s)
      await until(
        async () =>
          outText(await journal(fx.state, channel)).includes(
            'request_permission',
          ),
        'the question, recorded',
        30,
      );
      for (let i = 0; i < 8; i++) { // 16 s: past the orphan restart (5 s) and its retries (10 s apart)
        assertEquals(
          await processesUnder(installA),
          [],
          'no AIB.exe started again by the keeper',
        );
        const [s] = await httpJson(
          'GET',
          PORT,
          '/api/live/bootstrap',
          null,
          undefined,
          1000,
        ).catch(() => [0]);
        assert(s !== 200, 'nothing serves the page');
        await new Promise((r) => setTimeout(r, 2000));
      }
      assert(pidAlive(agentPid), 'the agent still runs');
      assertEquals(readKeeperInfo(fx.state)!.pid, keeperPid);

      // ---- the person unzips a newer build somewhere else and starts it: it takes the chat over
      const bPid = spawn(`${appB}\\AIB.exe`, appB);
      pids.add(bPid);
      const bootB = await until(
        async () => {
          const [s, b] = await httpJson(
            'GET',
            PORT,
            '/api/live/bootstrap',
            null,
            undefined,
            3000,
          );
          return s === 200 ? b : null;
        },
        'B on the same port',
        90,
      );
      const tokenB = String(bootB.token);
      assertEquals(
        (await httpJson('GET', PORT, '/api/live/update', tokenB))[1].current,
        NEXT,
        'B runs',
      );
      assertEquals([bootB.hostMode, bootB.instanceId], [
        'keeper',
        bootA.instanceId,
      ], 'same instance: open pages keep the chat');
      const asked = await until(
        async () => {
          const s = await state(tokenB);
          return s.id === cid && s.ready &&
              (s.permissions as Json[]).length === 1
            ? s
            : null;
        },
        'the question on B',
        60,
      );
      assertEquals(asked.error, '');
      assertEquals(
        (asked.events as Json[]).filter((e) => e.kind === 'permission').length,
        1,
        'the question shows once',
      );
      assertEquals(
        (asked.events as Json[]).filter((e) => e.kind === 'user').length,
        1,
        'the prompt shows once',
      );
      assertEquals(
        keeperJson(fx.state).held,
        false,
        'an AIB is back: the hold ended',
      );
      const key = (asked.permissions as Json[])[0].key;
      assertEquals(
        (await post(tokenB, 'permission', { id: cid, key, option: 'yes' }))[0],
        200,
      );
      const done = await until(
        async () => {
          const s = await state(tokenB);
          return !s.busy ? s : null;
        },
        'turn end on B',
        60,
      );
      const expected = Array.from({ length: CHUNKS }, (_, i) => (i === CHUNKS / 2 ? 'answer=yes ' : '') + `chunk${i} `).join('');
      assertEquals(
        said(done),
        expected,
        'every chunk once, in order, across the quit and the new build',
      );
      assertEquals(
        (done.events as Json[]).filter((e) => e.kind === 'turn_end').length,
        1,
      );
      const received = Deno.readTextFileSync(agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      assertEquals(
        received.filter((m) => m.method === 'session/prompt').length,
        1,
        'the prompt reached the agent once',
      );
      assertEquals(
        received.filter((m) => m.id === 'stream-ask' && !m.method).length,
        1,
        'the answer reached the agent once',
      );
      const sent = sentLines(await journal(fx.state, channel));
      assertEquals(sent.filter((m) => m.method === 'session/prompt').length, 1);
      assertEquals(
        sent.filter((m) => m.id === 'stream-ask' && !m.method).length,
        1,
      );
      const now = await KeeperClient.connect(
        readKeeperInfo(fx.state)!,
        'keeper e2e test',
      );
      const after = (await now.list()).find((c) => c.channel === channel)!;
      now.close();
      assertEquals(
        [after.live, after.pid],
        [true, agentPid],
        'the same agent process',
      );
      assertEquals(
        readKeeperInfo(fx.state)!.pid,
        keeperPid,
        'the same keeper process',
      );
      const logB = Deno.readTextFileSync(`${fx.state}\\studio.log`);
      assert(
        logB.includes('keeper: 1 chat(s) taken over from the keeper'),
        logB.slice(-3000),
      );
    } finally {
      // The keeper first: with a live chat and no client it could start AIB again (its orphan command).
      if (keeperPid && pidAlive(keeperPid)) {
        try {
          Deno.kill(keeperPid, 'SIGKILL');
        } catch { /* gone */ }
      }
      for (const folder of [installA, installB, fx.state]) {
        for (
          const [pid] of await processesUnder(folder).catch(() => [] as [number, string][])
        ) pids.add(pid);
      }
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
