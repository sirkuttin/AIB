/**
 * The keeper gaps before default-on, one regression test (or more) each, with the real keeper (built from keeper/ with Go), the fake
 * ACP agent (work/fake_acp.py) and temp state folders:
 *
 *   1. The saved switch (Settings > server.keeper, AIB_KEEPER overrides): a Studio with it on starts chats in the keeper; with it
 *      off but a keeper holding chats, those are taken over and stay in the keeper until they end (then the keeper is let go), while
 *      new chats run as children.
 *   3. The MCP forwarder (`AIB-keeper mcp-forward`): an agent in the keeper gets the keeper's program as its artifact tool, never
 *      AIB's own, and the tool answers from whichever AIB runs now (it survives a switch to another Studio on another port).
 *   4. A split agent host left by an older version: stopped at once when nothing works there (one process now), drained otherwise,
 *      with the reason in the page's banner.
 *   5. Snapshots and truncation: a turn end writes a snapshot and lets the keeper drop older segments; a rebuild starts at the
 *      snapshot, numbers every event as before (Studio's own events included), keeps the page's cursor, and goes on without
 *      sending anything twice. The page's state call waits while chats are being taken over.
 *
 * Item 2 (the tray-only start) is in desktop_window_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink, keeperOverride, keeperSetting, keeperWanted } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { codeWarning, leaveSplitHost, pidAlive, readInfo, setDrainToKeeper } from '../../outputs/agent-studio/server/host/host_client.ts';
import { SettingsStore } from '../../outputs/agent-studio/server/state/settings.ts';
import { FORWARD_FILE } from '../../outputs/agent-studio/server/artifacts/mcp_http.ts';
import { DENO, FAKE_HOST, Fixture } from './_host_fixture.ts';
import { APP_ID, CODE_ROOT, PROTOCOL_VERSION } from '../../outputs/agent-studio/server/host/host_client.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const DEC = new TextDecoder();
const ENC = new TextEncoder();

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-keeper-gaps-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly agentLog = this.dir + SEP + 'agent-received.log';
  readonly studios: Studio[] = [];
  readonly children: Deno.ChildProcess[] = [];

  constructor(readonly keeperArgs: string[] = []) {
    Deno.mkdirSync(this.work, { recursive: true });
  }

  /** A Studio with its own keeper link (no orphan command: a test never starts AIB again). */
  studio(keeperForNew = true): Studio {
    const keeper = new KeeperLink({
      dataDir: this.state,
      orphan: null,
      extraArgs: ['--exit-after', '2s', '--orphan-after', '30s', ...this.keeperArgs],
    });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake('--cancel-aware'), cwd, provider, { ...options, env: { FAKE_ACP_LOG: this.agentLog } });
    this.studios.push(studio);
    return studio;
  }

  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1);
  }

  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const child of this.children) {
      try {
        child.kill();
      } catch { /* gone */ }
    }
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    const info = readKeeperInfo(this.state);
    if (info && pidAlive(info.pid)) {
      try {
        const client = await KeeperClient.connect(info);
        await client.shutdown(true).catch(() => {});
        client.close();
      } catch { /* gone */ }
      await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
    }
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

const prompts = (lines: Json[]) => lines.filter((m) => m.method === 'session/prompt');
const answers = (lines: Json[], id: string) => lines.filter((m) => m.id === id && !m.method);
const shape = (events: Json[]) => events.map((e) => JSON.stringify([e.seq, e.kind, e.data]));

/** One whole turn: `stream:<n>:10`, the question halfway answered yes, until the turn ends. */
async function turn(studio: Studio, c: Connection, n: number, messageId: string): Promise<void> {
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: `stream:${n}:10`, clientMessageId: messageId }))[0], 200);
  await until(() => c.permissions.size === 1, `the question of ${messageId}`, 10);
  assertEquals((await studio.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' }))[0], 200);
  await until(() => !c.busy, `the end of ${messageId}`, 10);
}

// ---- 1. the saved switch ----------------------------------------------------------------------------------------------------

Deno.test('keeper switch: off by default; the Settings value turns it on; AIB_KEEPER=1/0 wins over it', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-keeper-switch-' });
  try {
    const env = (value?: string) => (name: string) => (name === 'AIB_KEEPER' ? value : undefined);
    assertEquals(keeperSetting(dir, env()), false, 'off by default');
    const settings = new SettingsStore(dir);
    assertEquals(settings.keeper(), false);
    await settings.update({ server: { keeper: true } });
    assertEquals([new SettingsStore(dir).keeper(), keeperSetting(dir, env())], [true, true], 'saved, and read from the file');
    assertEquals(keeperSetting(dir, env('0')), false, 'AIB_KEEPER=0 overrides the saved on');
    await settings.update({ server: { keeper: false } });
    assertEquals(keeperSetting(dir, env('1')), true, 'AIB_KEEPER=1 overrides the saved off');
    assertEquals(keeperSetting(dir, env('yes')), false, 'anything else: the saved value');
    assertEquals(keeperOverride(env('1')), true);
    assertEquals(keeperOverride(env()), null);
    let refused = '';
    await settings.update({ server: { keeper: 'on' } }).catch((e) => (refused = e.message));
    assertEquals(refused, 'keeper must be true or false');
    assertEquals((settings.public().settings as Json & { server: Json }).server.keeper, undefined, 'off: absent, as in the Python reference');
    await settings.update({ server: { keeper: true } });
    assertEquals((settings.public().settings as Json & { server: Json }).server.keeper, true, 'the page sees it');
    await settings.update({ server: { keeper: false } });
    assertEquals(keeperWanted(dir, env()), false, 'off and no keeper running: nothing changes');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: 'keeper switch: a Studio started with it off takes over the chats a keeper holds; they stay there until they end; new chats run as children',
  ...T,
  async fn() {
    if (keeperOverride() !== null) return; // AIB_KEEPER is set in this shell: the constructor's choice is the variable's
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio(); // the switch on (a test link)
    const c = await a.connect('omp', lab.work);
    assert(c.channel, 'started in the keeper');
    await turn(a, c, 2, 'm1');
    const keeperPid = readKeeperInfo(lab.state)!.pid;
    const agentPid = c.process!.pid;
    lab.crash(a);

    // What a launch with the saved switch off and a keeper still running builds (no link passed: the Studio decides).
    const plain = new Studio({ ompCommand: 'unused', stateDir: lab.state, port: 0, ownersDir: null });
    assert(plain.keeper !== null, 'a keeper runs: a link to take its chats over');
    assertEquals([plain.keeperForNew, plain.hostMode], [false, 'in-process']);
    await plain.close();
    await new SettingsStore(lab.state).update({ server: { keeper: true } });
    const on = new Studio({ ompCommand: 'unused', stateDir: lab.state, port: 0, ownersDir: null });
    assertEquals([on.keeper !== null, on.keeperForNew, on.hostMode], [true, true, 'keeper']);
    await on.close();
    await new SettingsStore(lab.state).update({ server: { keeper: false } });

    const b = lab.studio(false);
    assertEquals(await b.adoptKeeper(), 1, 'taken over although the switch is off');
    const r = b.connections.get(c.id)!;
    assertEquals([r.ready, r.process!.pid, r.channel !== null], [true, agentPid, true]);
    const fresh = await b.connect('claude', lab.work); // another provider: the fake agent's session id is always the same
    assertEquals(fresh.channel, null, 'a new chat runs as a child of AIB, as without the keeper');
    assertEquals((await (await b.keeper!.client(false))!.list()).filter((ch) => ch.live).length, 1, 'only the old chat is in the keeper');
    await turn(b, r, 2, 'm2'); // it goes on in the keeper
    assertEquals(prompts(lab.received()).length, 2);
    // It ends: the keeper is let go and exits by itself; the child chat goes on.
    await b.liveCall('disconnect', { id: r.id });
    await until(() => !pidAlive(keeperPid), 'the keeper exits once its last chat ended', 15);
    assert(!fresh.closed && fresh.ready, 'the chat outside the keeper is untouched');
  },
});

// ---- 3. the MCP forwarder ---------------------------------------------------------------------------------------------------

/** One JSON-RPC line to the forwarder and the line it answers. */
async function ask(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  lines: AsyncIterator<string>,
  message: Json,
  seconds = 20,
): Promise<Json> {
  await writer.write(ENC.encode(JSON.stringify(message) + '\n'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const line = await Promise.race([
    lines.next(),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('no answer from the forwarder')), seconds * 1000))),
  ]);
  clearTimeout(timer);
  return JSON.parse((line as IteratorResult<string>).value);
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += DEC.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
    }
  }
}

Deno.test({
  name: 'MCP forwarder: an agent in the keeper runs the keeper program as its artifact tool, which answers across a switch to the next AIB',
  ...T,
  async fn() {
    const keeperProgram = await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    const entry = c.mcpServers.find((m) => (m as unknown as Json).name === 'studio_artifact') as unknown as Json;
    assert(entry, 'the artifact tool is offered');
    assertEquals(entry.command, keeperProgram, 'the keeper program, never AIB\'s own (its files may be replaced by an update)');
    assertEquals(entry.args, ['mcp-forward', `${lab.state}${SEP}${FORWARD_FILE}`]);
    assert(!JSON.stringify(c.mcpServers).includes('mcp-artifact'), 'no AIB mcp-artifact child for an agent in the keeper');
    assert(c.ownArtifactTool({ toolCall: { title: 'mcp__studio_artifact__publish' } }), 'still recognised as Studio\'s own tool');
    const note = JSON.parse(Deno.readTextFileSync(`${lab.state}${SEP}${FORWARD_FILE}`));
    assertEquals(note.pid, Deno.pid);

    const env = Object.fromEntries((entry.env as { name: string; value: string }[]).map((e) => [e.name, e.value]));
    const child = new Deno.Command(String(entry.command), {
      args: entry.args as string[],
      env,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    lab.children.push(child);
    const writer = child.stdin.getWriter();
    const lines = readLines(child.stdout);
    const first = await ask(writer, lines, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assertEquals(first.id, 1);
    assert(Array.isArray((first.result as Json)?.tools), JSON.stringify(first));

    // AIB exits for an update (release: the chat stays in the keeper); the tool waits for the next AIB, then answers from it.
    assertEquals(await a.release(), 1);
    lab.studios.splice(lab.studios.indexOf(a), 1);
    let gone = false;
    try {
      Deno.statSync(`${lab.state}${SEP}${FORWARD_FILE}`);
    } catch {
      gone = true;
    }
    assert(gone, 'the old address is withdrawn');
    const pending = ask(writer, lines, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await pause(500);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const second = await pending;
    assertEquals(second.id, 2);
    assert(Array.isArray((second.result as Json)?.tools), JSON.stringify(second));
    assert(JSON.parse(Deno.readTextFileSync(`${lab.state}${SEP}${FORWARD_FILE}`)).url !== note.url, 'another endpoint now');
    await writer.close();
    assertEquals((await child.status).code, 0);
    lab.children.splice(0);
  },
});

// ---- 4. a split agent host from an older version ----------------------------------------------------------------------------

Deno.test({
  name: 'split host: with the keeper switch on, a host with nothing working is stopped at once; one with working chats is drained and the banner says why',
  ...T,
  async fn() {
    await using fx = new Fixture();
    const start = async (active: number) => {
      Deno.writeTextFileSync(`${fx.state}${SEP}fake-active`, String(active));
      const [child] = fx.spawn(
        [DENO, 'run', '-A', '--quiet', FAKE_HOST, fx.state, CODE_ROOT, APP_ID, '0.0.9', 'deno', String(PROTOCOL_VERSION)],
        'old-host',
      );
      await until(async () => (await readInfo(fx.state))?.pid === child.pid, 'old host file', 30);
      return child;
    };
    // Working chats there: they are its children, so they stay (drain), and the page's banner says why.
    const busy = await start(1);
    const said: string[] = [];
    assertEquals(await leaveSplitHost(fx.state, (l) => said.push(l)), false);
    assert(said[0].includes('cannot move into the keeper mid-turn'), said[0]);
    assert(pidAlive(busy.pid), 'never stopped while a chat works there');
    const info = await readInfo(fx.state);
    const banner = await codeWarning({ ...info, active: [{}] });
    assert(banner.includes('cannot move into the keeper while they work'), banner);
    assert(banner.includes('AIB 0.0.9'), banner);
    // Nothing works any more: the next start stops it at once and runs as one process.
    Deno.writeTextFileSync(`${fx.state}${SEP}fake-active`, '0');
    assertEquals(await leaveSplitHost(fx.state, (l) => said.push(l)), true);
    await until(() => !pidAlive(busy.pid), 'the old host exited', 10);
    assert(said.at(-1)!.includes('stopped it to run as one process'), said.at(-1));
    assertEquals(await codeWarning({ ...info, active: [] }) === banner, false, 'no keeper banner once it is gone');
    setDrainToKeeper(null);
  },
});

// ---- 5. snapshots, truncation and stable event ids --------------------------------------------------------------------------

Deno.test({
  name: 'snapshots: a turn end writes one; a rebuild starts there, numbers every event as before (Studio events too) and sends nothing twice',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await turn(a, c, 4, 'm1');
    await turn(a, c, 4, 'm2');
    await until(() => c.snapshots >= 2, 'a snapshot at each turn end', 10);
    assert(await a.emitArtifact(c.id, { type: 'artifact', name: 'page.html', version: 1 }), 'Studio\'s own event');
    await pause(300); // its note reaches the record
    const before = shape(c.events);
    const cursor = c.sequence;
    const eventsId = c.eventsId;
    lab.crash(a);

    const b = lab.studio();
    const adopting = b.adoptKeeper();
    // An open page polls meanwhile: its state call waits for the take-over instead of "connection not found".
    const state = await b.liveState(c.id, cursor) as Json;
    assertEquals(await adopting, 1);
    assert(state !== null, 'the page keeps its chat');
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assert(r.replayedFrom > 0, 'started at a snapshot, not at the start of the record');
    assert(r.replayedRecords <= 3, `only what came after the snapshot was replayed (${r.replayedRecords})`);
    assertEquals(shape(r.events), before, 'every event, with the same numbers');
    assertEquals([r.sequence, r.eventsId], [cursor, eventsId]);
    const page = r.public(cursor);
    assertEquals([page.events, page.reset, page.eventsId], [[], false, eventsId], 'the page goes on from its cursor');
    const stale = r.public(cursor + 50);
    assertEquals([stale.reset, (stale.events as Json[]).length], [true, r.events.length], 'a cursor from another numbering: all again');
    assertEquals(b.store!.receipt('omp', 'fake-session', 'm2')!.state, 'finished');

    // It goes on: ids and once-keys continue where the old AIB left them (nothing refused, nothing sent twice).
    await turn(b, r, 2, 'm3');
    const got = lab.received();
    assertEquals(prompts(got).length, 3);
    assertEquals(new Set(prompts(got).map((m) => m.id)).size, 3, 'no request id reused');
    assertEquals(answers(got, 'stream-ask').length, 3, 'each question answered once');
  },
});

Deno.test({
  name: 'snapshots: the keeper drops journal segments before a snapshot; a rebuild of the truncated record still works',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab(['--segment-bytes', '2048']);
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    for (let i = 1; i <= 4; i++) await turn(a, c, 6, `m${i}`);
    await until(() => c.snapshots >= 4, 'snapshots', 10);
    const client = (await a.keeper!.client(false))!;
    await until(async () => ((await client.list()).find((ch) => ch.channel === `chat-${c.id}`)?.first ?? 1) > 1, 'old segments gone', 10);
    const before = shape(c.events);
    lab.crash(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1, 'found by the snapshot\'s copy of the chat note');
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assertEquals(shape(r.events), before);
    await turn(b, r, 2, 'm5');
    assertEquals(prompts(lab.received()).length, 5);
  },
});

Deno.test({
  name: 'snapshots: a chat whose record has no snapshot (an older AIB) is still rebuilt from the start',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await a.liveCall('prompt', { id: c.id, text: 'stream:6:80', clientMessageId: 'm1' });
    await until(() => c.permissions.size === 1, 'the question', 10);
    assertEquals(c.snapshots, 0, 'mid-turn: nothing quiet to snapshot yet');
    lab.crash(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals([r.replayedFrom, r.rebuildError], [0, '']);
    await until(() => r.permissions.size === 1, 'the question again', 10);
    assertEquals((await b.liveCall('permission', { id: r.id, key: [...r.permissions.keys()][0], option: 'yes' }))[0], 200);
    await until(() => !r.busy, 'turn end', 15);
    assertEquals(answers(lab.received(), 'stream-ask').length, 1);
  },
});
