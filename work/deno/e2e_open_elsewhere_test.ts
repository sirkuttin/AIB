/**
 * Open elsewhere (aib-shared/designs/open-elsewhere/research.md; server/ownership/handoff.ts): AIB lets go of a Claude Code chat that
 * another app opened, and takes it back when the person returns (the port of work/test_open_elsewhere_e2e.py).
 *
 * A real AIB (deno-split web server + agent host) runs a real Claude Code chat through the real ACP adapter against the local stub
 * model API (work/stub_model_api.js): no key, no network, a throwaway HOME / CLAUDE_CONFIG_DIR (acp/connection.ts testHomeEnv, placed
 * in this test's temp folder through TMP). "Another app" is the real `claude` CLI started by the test with that same temp config:
 * `claude --resume <session> -p --input-format stream-json` stays running (holding the session, as an open VS Code tab or terminal
 * does) until the test closes its stdin, and each line the test writes is a turn typed there.
 *
 *   test_idle_chat_lets_go_and_comes_back_with_the_outside_turn
 *       AIB chat idle; the second process appears -> AIB closes its session (its own Claude process and registry record go), the chat
 *       line says so; AIB's own process never counted as "elsewhere" before. A turn typed in the other process; the other process
 *       quits; sending in AIB loads the chat again, shows the outside turn and its reply continues from it.
 *   test_running_turn_lets_go_only_after_the_turn
 *       A turn is running (the stub holds the reply); the second process appears -> nothing is cut: the turn ends with its reply,
 *       then AIB lets go.
 *   test_still_held_needs_open_here_anyway
 *       Released, the other process still runs: sending is refused (409 held_elsewhere, nothing sent, one line with Open here
 *       anyway); Open here anyway takes it back.
 * The same three flows run again with the chat's agent in the keeper (OpenElsewhereKeeperTest, the owner's setup).
 *
 * Skipped without node, the Claude Code ACP adapter, or the `claude` CLI (AIB_CLAUDE_CLI, else PATH). Targeted: run this file alone.
 */
import { assert, assertEquals, Chat, Json, sleep, waitFor } from './_e2e.ts';
import {
  agentTempRoot,
  CLAUDE_ACP,
  CLAUDE_CLI,
  HAVE_KEEPER_BIN,
  join,
  keeperPids,
  keeperProgram,
  makeProject,
  NODE_EXE,
  OwnerGuard,
  pidAlive,
  RealClaudeFixture,
  SERVER_SPLIT,
  Spawned,
  Stub,
  stubClaudeEnv,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';

// The ownership beat is 10 s in the app; 1 s in these runs (handoff.ts RESCAN_MS), inherited by the servers and hosts they start.
Deno.env.set('AIB_TEST_RESCAN_MS', '1000');

const RELEASED_LINE = 'Continued in a terminal. AIB let go of this chat. Open it here to take it back.';
const WIN = Deno.build.os === 'windows';

/** {pid: record} of Claude Code's registry files that name the session. */
function sessionRecords(home: string, session: string): Record<number, Json> {
  const out: Record<number, Json> = {};
  const folder = join(home, 'sessions');
  try {
    for (const e of Deno.readDirSync(folder)) {
      if (!e.name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(Deno.readTextFileSync(join(folder, e.name)));
        if (data.sessionId === session) out[Number(data.pid ?? 0)] = data;
      } catch { /* half-written */ }
    }
  } catch { /* none */ }
  return out;
}

/** The agent's throwaway home (testHomeEnv: HOME and CLAUDE_CONFIG_DIR): the temp folder whose registry names this chat's session. */
function agentHome(session: string, ...roots: string[]): string | null {
  for (const root of [...roots, Deno.env.get('TEMP') ?? Deno.env.get('TMPDIR') ?? '/tmp']) {
    try {
      for (const e of Deno.readDirSync(root)) {
        if (!e.name.startsWith('agent-studio-test-home-')) continue;
        const home = join(root, e.name);
        if (Object.keys(sessionRecords(home, session)).length) return home;
      }
    } catch { /* none */ }
  }
  return null;
}

/** `claude --resume <id> -p --input-format stream-json` in the agent's temp home: holds the session until stdin closes. */
class OtherApp {
  results: Json[] = [];
  proc: Spawned;

  constructor(home: string, project: string, stub: Stub, session: string) {
    let env: Record<string, string> = {};
    for (const [k, v] of Object.entries(Deno.env.toObject())) if (!/^(CLAUDE|ANTHROPIC|AIB_|AGENT_STUDIO)/i.test(k)) env[k] = v;
    for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) env[name] = home;
    for (const name of ['TMP', 'TEMP', 'TMPDIR']) env[name] = join(home, 'tmp');
    env.CLAUDE_CONFIG_DIR = home;
    env = stubClaudeEnv(env, stub);
    this.proc = new Spawned(CLAUDE_CLI!, ['--resume', session, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      cwd: project,
      env,
      onStdoutLine: (line) => {
        try {
          const item = JSON.parse(line);
          if (item.type === 'result') this.results.push(item);
        } catch { /* not JSON */ }
      },
    });
  }
  get pid() {
    return this.proc.pid;
  }
  /** One turn typed in the other app; returns its result text. */
  async say(text: string): Promise<string> {
    const before = this.results.length;
    await this.proc.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    await waitFor(() => this.results.length > before || this.proc.exited, 'the other app to answer', 120);
    if (this.results.length <= before) throw new Error(`the other app ended: ${this.proc.lines.slice(-5)} ${this.proc.stderrText().slice(-2000)}`);
    return String(this.results[this.results.length - 1].result ?? '');
  }
  stop() {
    return this.proc.stop();
  }
}

class World {
  temp = new Temp('aib-oe-');
  stub!: Stub;
  project!: string;
  guard!: OwnerGuard;
  serverTmp = this.temp.join('tmp');
  fx!: RealClaudeFixture;
  chat!: Chat;
  web!: import('./_host_fixture.ts').Web;
  home = '';
  keeper: string | null = null;
  others: OtherApp[] = [];

  static async start(keeper: boolean): Promise<World> {
    const w = new World();
    w.stub = await Stub.start(w.temp.path);
    w.project = makeProject(w.temp.path, `proj-${uuid().slice(0, 6)}`);
    w.guard = new OwnerGuard([w.project]);
    Deno.mkdirSync(w.serverTmp);
    if (keeper) {
      w.keeper = keeperProgram();
      // the chat's agent in the keeper (the owner's setup); the server's own temp folder is this test's (the keeper's files)
      w.fx = new RealClaudeFixture(w.stub, agentTempRoot(), { extraEnv: { AIB_KEEPER: '1', AIB_KEEPER_BIN: w.keeper, TEMP: w.serverTmp, TMP: w.serverTmp, TMPDIR: w.serverTmp } });
    } else {
      w.fx = new RealClaudeFixture(w.stub, agentTempRoot()); // the split agent host runs the agent (AIB_KEEPER=0, the e2e default)
    }
    w.web = await w.fx.startWeb();
    const [status, connection] = await w.web.post('connect', { provider: 'claude', cwd: w.project, background: true });
    assertEquals(status, 200, JSON.stringify(connection));
    w.chat = new Chat(null, connection.id as string, w.web);
    await waitFor(async () => {
      const s = await w.chat.state();
      if (s.error) throw new Error(String(s.error));
      return s.ready;
    }, 'chat ready', 120);
    w.home = (await waitFor(async () => agentHome(await w.chat.session(), w.serverTmp), "the agent's temp home", 30)) as string;
    Deno.mkdirSync(join(w.home, 'tmp'), { recursive: true });
    if (keeper) assert(keeperPids(w.keeper!).length > 0 || !WIN, 'the chat runs in a keeper');
    return w;
  }

  other(session: string): OtherApp {
    const o = new OtherApp(this.home, this.project, this.stub, session);
    this.others.push(o);
    return o;
  }

  async released(): Promise<boolean> {
    return (((await this.chat.state()).elsewhere as Json | undefined) ?? {}).released === true;
  }
  async notes(kind?: string): Promise<Json[]> {
    return (await this.chat.notes()).filter((n) => kind === undefined || n.elsewhere === kind);
  }
  ownRecords(session: string, otherPid?: number): number[] {
    return Object.keys(sessionRecords(this.home, session)).map(Number).filter((pid) => pid !== otherPid && pidAlive(pid));
  }

  async dispose() {
    for (const o of this.others) await o.stop();
    await this.fx?.cleanup();
    if (this.keeper) for (const pid of keeperPids(this.keeper)) new Deno.Command('taskkill', { args: ['/PID', String(pid), '/T', '/F'], stdout: 'null', stderr: 'null' }).outputSync(); // only keepers of this test's own program
    await this.stub?.stop();
    try {
      this.guard?.check();
    } finally {
      this.temp[Symbol.dispose]();
    }
  }
  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
}

function register(prefix: string, keeper: boolean) {
  const ok = !!(NODE_EXE && CLAUDE_ACP && CLAUDE_CLI && SERVER_SPLIT && (!keeper || HAVE_KEEPER_BIN));
  const t = (name: string, fn: (w: World) => Promise<void>) =>
    Deno.test({
      name: `${prefix} ${name}`,
      ignore: !ok,
      ...T,
      async fn() {
        await using w = await World.start(keeper);
        await fn(w);
      },
    });

  t('test_idle_chat_lets_go_and_comes_back_with_the_outside_turn', async (w) => {
    const chat = w.chat;
    assert((await chat.send('Remember: the codeword is ALPHA')).includes('STUB codeword=ALPHA'));
    const session = await chat.session();
    const mine = w.ownRecords(session);
    assertEquals(mine.length, 1, `AIB's own Claude process has the registry record: ${mine}`);
    await sleep(3500); // a watcher event and the backup scan (1 s here, 10 s in the app: handoff.ts RESCAN_MS) have both run: AIB's own process is never "elsewhere"
    assert(!('elsewhere' in (await chat.state())), 'AIB counted its own Claude process as another app');

    const other = w.other(session);
    const started = Date.now();
    await waitFor(() => w.released(), 'AIB to let go of the idle chat', 30);
    assert(Date.now() - started < 15000, 'letting go took too long');
    assertEquals((await w.notes('released')).map((n) => n.message), [RELEASED_LINE]);
    assertEquals((await w.notes('released'))[0].actions, [{ id: 'elsewhere-open', label: 'Open here' }]);
    await waitFor(() => w.ownRecords(session, other.pid).length === 0, "AIB's Claude process and its record to go", 15);
    assert(!(await chat.state()).closed, 'the chat stays open in AIB (only the session was closed)');

    assert((await other.say('Typed elsewhere: the codeword is BETA')).includes('STUB codeword=BETA'));
    await other.stop();
    await waitFor(() => !pidAlive(other.pid), 'the other app to quit', 20);

    const reply = await chat.send('What is the codeword now?');
    assert(reply.includes('STUB codeword=BETA'), 'the reloaded chat continues from the turn typed elsewhere');
    const state = await chat.state();
    assert(!('elsewhere' in state));
    const users = (await chat.state(0)).events
      .filter((e) => e.kind === 'update' && (e.data.update as Json).sessionUpdate === 'user_message_chunk')
      .map((e) => String((((e.data.update as Json).content as Json).text) ?? ''));
    assert(users.some((u) => u.includes('Typed elsewhere: the codeword is BETA')), JSON.stringify(users));
    assert(!users.some((u) => u.includes('Remember: the codeword is ALPHA')), 'AIB showed its own history again');
    assertEquals((await w.notes('back')).map((n) => n.message), ['AIB took this chat back, with 1 turn from a terminal above.']);
    assertEquals(w.ownRecords(session).length, 1, 'AIB holds the session again');
  });

  t('test_running_turn_lets_go_only_after_the_turn', async (w) => {
    const chat = w.chat;
    assert((await chat.send('the codeword is ONE')).includes('STUB codeword=ONE'));
    const session = await chat.session();
    const [status, sent] = await w.web.post('prompt', { id: chat.id, text: 'STUB_WAIT=8 the codeword is GAMMA', clientMessageId: uuid() });
    assertEquals(status, 200, JSON.stringify(sent));
    await waitFor(async () => (await chat.state()).busy, 'the turn to run');
    const other = w.other(session);
    await waitFor(async () => (await chat.state()).elsewhere, 'AIB to notice the other app', 30);
    const state = await chat.state();
    assert(state.busy, 'the turn still runs');
    assert(!(state.elsewhere as Json).released, 'AIB waits for the turn before it lets go');
    await waitFor(() => w.released(), 'AIB to let go after the turn', 60);
    const events = (await chat.state(0)).events;
    const said = events
      .filter((e) => e.kind === 'update' && (e.data.update as Json).sessionUpdate === 'agent_message_chunk')
      .map((e) => String((((e.data.update as Json).content as Json).text) ?? '')).join('');
    assert(said.includes('STUB codeword=GAMMA'), 'the running turn finished with its reply');
    const ends = events.filter((e) => e.kind === 'turn_end').map((e) => e.data.stopReason);
    assertEquals(ends[ends.length - 1], 'end_turn');
    assertEquals((await w.notes('released')).length, 1);
    await other.stop();
  });

  t('test_still_held_needs_open_here_anyway', async (w) => {
    const chat = w.chat;
    assert((await chat.send('the codeword is ALPHA')).includes('STUB codeword=ALPHA'));
    const session = await chat.session();
    const other = w.other(session);
    await waitFor(() => w.released(), 'AIB to let go', 30);
    const calls = w.stub.calls().length;
    const [status, refused] = await w.web.post('prompt', { id: chat.id, text: 'Are you there?', clientMessageId: uuid() });
    assertEquals(status, 409, JSON.stringify(refused));
    assertEquals(refused.code, 'held_elsewhere');
    assert(String(refused.error).includes('still open in a terminal'));
    const held = await w.notes('held');
    assertEquals(held.length, 1);
    assertEquals(held[0].actions, [{ id: 'elsewhere-force', label: 'Open here anyway' }]);
    // a second try adds no second line, and nothing reached the model
    assertEquals((await w.web.post('prompt', { id: chat.id, text: 'Again?', clientMessageId: uuid() }))[0], 409);
    assertEquals((await w.notes('held')).length, 1);
    assertEquals(w.stub.calls().length, calls, 'nothing was sent while another app holds the chat');
    assert(await w.released());
    // Open here (no force) while still held: stays released
    let [s2, answer] = await w.web.post('session-op', { id: chat.id, op: 'open-here' });
    assertEquals([s2, answer.state], [200, 'held'], JSON.stringify(answer));
    // Open here anyway
    [s2, answer] = await w.web.post('session-op', { id: chat.id, op: 'open-here', force: true });
    assertEquals([s2, answer.state], [200, 'back'], JSON.stringify(answer));
    assert(!('elsewhere' in (await chat.state())));
    await other.stop();
    await waitFor(() => !pidAlive(other.pid), 'the other app to quit', 20);
    assert((await chat.send('and the codeword?')).includes('STUB codeword=ALPHA'));
  });
}

register('OpenElsewhereTest', false);
register('OpenElsewhereKeeperTest', true);
