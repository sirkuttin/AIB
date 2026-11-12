/**
 * The keeper gaps before default-on, one regression test (or more) each, with the real keeper (built from keeper/ with Go), the fake
 * ACP agent (work/fake_acp.py) and temp state folders:
 *
 *   1. The start decision (always on; no setting; AIB_KEEPER=0 an internal off switch; a keeper that cannot run falls back with
 *      the reason for Settings > About): a Studio with it on starts chats in the keeper; without it but with a keeper holding
 *      chats, those are taken over and stay in the keeper until they end (then the keeper is let go), while new chats run as
 *      children.
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
import { Connection, MAX_EVENTS, MAX_SNAPSHOT_BYTES } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import {
  decideKeeper,
  KeeperLink,
  keeperProblem,
  keeperSetting,
  keeperWanted,
  setKeeperDecision,
} from '../../outputs/agent-studio/server/keeper/link.ts';
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

// ---- 1. the start decision -------------------------------------------------------------------------------------------------

Deno.test('keeper decision: on by default with no setting; AIB_KEEPER=0 turns it off quietly; an old saved server.keeper is ignored', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-keeper-switch-' });
  try {
    const env = (value?: string) => (name: string) => (name === 'AIB_KEEPER' ? value : undefined);
    const ok = { binary: () => keeperBinary() };
    // An old saved switch, off: no error, dropped on read, never shown, and it decides nothing.
    Deno.writeTextFileSync(`${dir}${SEP}studio-settings.json`, JSON.stringify({ version: 1, server: { keeper: false, autoReconnect: false } }));
    const settings = new SettingsStore(dir);
    const server = (settings.public().settings as Json & { server: Json }).server;
    assertEquals([server.keeper, server.autoReconnect], [undefined, false], 'dropped; the rest of the file still applies');
    let refused = '';
    await settings.update({ server: { keeper: true } }).catch((e) => (refused = e.message));
    assertEquals(refused, 'Unknown server setting', 'no such setting any more (as in the Python reference)');
    assertEquals(await decideKeeper(dir, { ...ok, env: env() }), true, 'on by default');
    assertEquals([keeperSetting(), keeperProblem()], [true, '']);
    assertEquals(await decideKeeper(dir, { ...ok, env: env('1') }), true, 'anything but 0: on');
    assertEquals(await decideKeeper(dir, { ...ok, env: env('0') }), false, 'AIB_KEEPER=0: off');
    assertEquals([keeperSetting(), keeperProblem()], [false, ''], 'the escape hatch shows nothing in the page');
    assertEquals(keeperWanted(dir), false, 'off and no keeper running: nothing changes');
  } finally {
    setKeeperDecision(null);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('keeper decision: a keeper that cannot run falls back (off) and says why for Settings > About', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-keeper-missing-' });
  try {
    const env = () => undefined;
    // The program is missing (a built app without it, or no Go in a source run): keeperBinary rejects.
    const missing = () => Promise.reject(new Error('AIB-keeper.exe was not found next to C:\\AIB\\AIB.exe'));
    assertEquals(await decideKeeper(dir, { env, binary: missing }), false);
    assertEquals(keeperSetting(), false, 'new chats run without the keeper');
    assert(keeperProblem().includes('was not found'), keeperProblem());
    // The program is there but does not run (spawn fails).
    assertEquals(await decideKeeper(dir, { env, binary: () => Promise.resolve(`${dir}${SEP}no-such-keeper.exe`) }), false);
    assert(keeperProblem().includes('could not be run'), keeperProblem());
    // A Studio built after the fallback: no keeper link, agents are its children.
    const studio = new Studio({ ompCommand: 'unused', stateDir: dir, port: 0, ownersDir: null });
    assertEquals([studio.keeper, studio.keeperForNew, studio.hostMode], [null, false, 'in-process']);
    await studio.close();
  } finally {
    setKeeperDecision(null);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: 'keeper fallback: a chat whose keeper cannot start runs as a child of AIB, and Settings > About says why',
  ...T,
  async fn() {
    await using lab = new Lab();
    const keeper = new KeeperLink({ dataDir: lab.state, orphan: null, binary: `${lab.dir}${SEP}no-such-keeper.exe`, waitSeconds: 2 });
    const studio = new Studio({ ompCommand: 'unused', stateDir: lab.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => new Connection(fake(), cwd, provider, options);
    lab.studios.push(studio);
    const c = await studio.connect('omp', lab.work);
    assertEquals([c.channel, c.ready], [null, true], 'the chat works, outside the keeper');
    assert(keeperProblem() !== '', 'the reason is kept for Settings > About');
    setKeeperDecision(null);
  },
});

Deno.test({
  name: 'keeper fallback: a Studio started without the keeper takes over the chats a keeper holds; they stay there until they end; new chats run as children',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio(); // the keeper on (a test link)
    const c = await a.connect('omp', lab.work);
    assert(c.channel, 'started in the keeper');
    await turn(a, c, 2, 'm1');
    const keeperPid = readKeeperInfo(lab.state)!.pid;
    const agentPid = c.process!.pid;
    lab.crash(a);

    // What a fallback start (the keeper not decided on) builds while a keeper still runs (no link passed: the Studio decides).
    const plain = new Studio({ ompCommand: 'unused', stateDir: lab.state, port: 0, ownersDir: null });
    assert(plain.keeper !== null, 'a keeper runs: a link to take its chats over');
    assertEquals([plain.keeperForNew, plain.hostMode], [false, 'in-process']);
    await plain.close();
    setKeeperDecision(true); // what main.ts decides when the keeper can run
    const on = new Studio({ ompCommand: 'unused', stateDir: lab.state, port: 0, ownersDir: null });
    setKeeperDecision(null);
    assertEquals([on.keeper !== null, on.keeperForNew, on.hostMode], [true, true, 'keeper']);
    await on.close();

    const b = lab.studio(false);
    assertEquals(await b.adoptKeeper(), 1, 'taken over although new chats run without the keeper');
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
  name: 'split host: with the keeper on, a host with nothing working is stopped at once; one with working chats is drained and the banner says why',
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

// ---- 6. a chat of any length: the snapshot stays small, the journal keeps only what the history needs ------------------------

/** The bytes of a channel's journal on disk (every segment). */
function journalBytes(state: string, id: string): number {
  const find = (dir: string): string | null => {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isDirectory) continue;
      const path = dir + SEP + entry.name;
      if (entry.name === `chat-${id}`) return path;
      const inner = find(path);
      if (inner) return inner;
    }
    return null;
  };
  const dir = find(state);
  if (!dir) return 0;
  let sum = 0;
  for (const entry of Deno.readDirSync(dir)) if (entry.isFile) sum += Deno.statSync(dir + SEP + entry.name).size;
  return sum;
}

const jsonBytes = (value: unknown) => ENC.encode(JSON.stringify(value)).length;

Deno.test({
  name: 'snapshots: a chat with 50 MB of history writes small snapshots; a take-over has every event, the question once and the queue',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    // 1000 tool outputs of 50 KiB: far beyond the 12 MiB a snapshot note may hold (beta.8 then stopped writing snapshots).
    assertEquals((await a.liveCall('prompt', { id: c.id, text: 'bulk:1000:50', clientMessageId: 'm0' }))[0], 200);
    await until(() => !c.busy && c.snapshots >= 1, 'the bulk turn ended and a snapshot was written', 180);
    const history = jsonBytes(c.events);
    assert(history > 50_000_000, `50 MB of history (${history})`);
    assert(c.snapshotBytes <= MAX_SNAPSHOT_BYTES, `the snapshot note fits (${c.snapshotBytes})`);
    assert(c.snapshotChunkBytes > 40 * 1024 * 1024, `the history went into chunk notes once (${c.snapshotChunkBytes})`);

    await turn(a, c, 4, 'm1');
    await until(() => c.snapshots >= 2, 'a snapshot at the turn end', 10);
    assert(c.snapshotBytes < 256 * 1024, `the next snapshot holds only what is new (${c.snapshotBytes})`);
    assertEquals(c.snapshotChunkBytes, 0, 'no history written again');

    // Mid-turn with a question open, and a message queued behind it.
    assertEquals((await a.liveCall('prompt', { id: c.id, text: 'stream:6:20', clientMessageId: 'm2' }))[0], 200);
    await until(() => c.permissions.size === 1, 'the question of m2', 10);
    assertEquals((await a.liveCall('queue', { id: c.id, text: 'sleep:0', clientMessageId: 'q1' }))[0], 200);
    await pause(300); // the queue and the question reach the store and the record
    // The open question is asked again by the replay, under a new key (as before this change); everything else is identical.
    const unkeyed = (events: Json[]) => shape(events.map((e) => e.kind === 'permission' ? { ...e, data: { ...e.data as Json, key: '' } } : e));
    const before = unkeyed(c.events);
    const cursor = c.sequence;
    lab.crash(a);

    const b = lab.studio();
    const started = performance.now();
    assertEquals(await b.adoptKeeper(), 1);
    const took = performance.now() - started;
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assert(r.replayedFrom > 0, 'started at a snapshot');
    assert(r.replayedRecords < 40, `only the open turn was replayed (${r.replayedRecords})`);
    assert(took < 60000, `taken over in ${Math.round(took)} ms`);
    assertEquals(unkeyed(r.events), before, 'every event of the page, with the same numbers');
    assertEquals(r.sequence, cursor);
    assertEquals([r.public(cursor).events, r.public(cursor).reset], [[], false], 'an open page goes on from its cursor');
    assertEquals(r.busy, true, 'the turn still runs');
    assertEquals(r.permissions.size, 1, 'the open question, once');
    assertEquals(((r.queue.public() as Json).items as Json[]).map((i) => i.text), ['sleep:0'], 'the queue');

    assertEquals((await b.liveCall('permission', { id: r.id, key: [...r.permissions.keys()][0], option: 'yes' }))[0], 200);
    await until(() => prompts(lab.received()).length === 4 && !r.busy, 'm2 ended and the queued message ran', 20);
    assertEquals(answers(lab.received(), 'stream-ask').length, 2, 'each question answered once');
    assertEquals(new Set(prompts(lab.received()).map((m) => m.id)).size, 4, 'no request id reused');
  },
});

Deno.test({
  name: 'snapshots: once old events leave the history, the journal segments holding them go; the take-over still has the whole history',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab(['--segment-bytes', String(1 << 20)]);
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    // 3 x 4000 events of 2 KiB: twice what the history keeps (MAX_EVENTS), ~25 MB through the record.
    let peak = 0;
    for (let i = 1; i <= 3; i++) {
      assertEquals((await a.liveCall('prompt', { id: c.id, text: 'bulk:4000:2', clientMessageId: `b${i}` }))[0], 200);
      await until(() => !c.busy && c.snapshots >= i, `bulk turn ${i} and its snapshot`, 120);
      await pause(300); // the truncate reaches the keeper
      peak = Math.max(peak, journalBytes(lab.state, c.id));
    }
    assertEquals(c.events.length, MAX_EVENTS);
    const window = jsonBytes(c.events);
    const kept = journalBytes(lab.state, c.id);
    // The kept record: the chunks of the history plus the raw records since its first event, and a segment of slack.
    assert(peak < 2 * window + 4 * (1 << 20), `journal at most ${peak} bytes (now ${kept}) for a ${window}-byte history`);
    const client = (await a.keeper!.client(false))!;
    const first = (await client.list()).find((ch) => ch.channel === `chat-${c.id}`)!.first as number;
    assert(first > 1, `old segments gone (first ${first})`);
    assert(c.snapshotBytes <= MAX_SNAPSHOT_BYTES);

    const before = shape(c.events);
    lab.crash(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1, 'found by the snapshot\'s copy of the chat note');
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assertEquals(shape(r.events), before, 'the whole history, from chunks of several snapshots');
    await turn(b, r, 2, 'm1');
    assertEquals(prompts(lab.received()).length, 4);
  },
});

Deno.test({
  name: 'snapshots: a record whose newest snapshot is beta.8\'s whole-history note is restored, and the next snapshot stores the history in chunks',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await turn(a, c, 4, 'm1');
    await until(() => c.snapshots >= 1, 'a snapshot', 10);
    // What beta.8 wrote: sv 1, the whole event list inside the state.
    const note = c.snapshotNote()!;
    delete note.events;
    const old = { ...note, sv: 1, state: { ...note.state as Json, events: c.events } };
    delete (old.state as Json).eventsFrom;
    assert(await c.channel!.snapshot(old), 'stored');
    await pause(300);
    const before = shape(c.events);
    lab.crash(a);

    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assert(r.replayedFrom > 0, 'started at the sv 1 snapshot');
    assertEquals(shape(r.events), before);
    await turn(b, r, 2, 'm2');
    await until(() => r.snapshots >= 1, 'a new snapshot', 10);
    const after = shape(r.events);
    lab.crash(b);

    const d = lab.studio();
    assertEquals(await d.adoptKeeper(), 1);
    const s = d.connections.get(c.id)!;
    assertEquals(s.rebuildError, '');
    assertEquals(shape(s.events), after, 'the history beta.8 kept, now from chunks');
    assertEquals(prompts(lab.received()).length, 2);
  },
});
