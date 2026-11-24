/**
 * Open elsewhere for Codex chats (server/ownership/handoff.ts, codex_threads.ts) (the port of work/test_codex_open_elsewhere_e2e.py):
 * AIB lets go of a Codex chat that a Codex CLI opened, and takes it back, with the turns written there, when the person returns.
 *
 * A real AIB (deno-split web server + agent host, the chat's agent in the keeper) runs a real Codex chat through AIB's pinned codex-acp
 * (AIB_CODEX_ACP) against the local stub model API (work/stub_model_api.js, plain mode: "the codeword is X" -> "STUB codeword=X"). No
 * key, no network, a throwaway CODEX_HOME (acp/connection.ts testHomeEnv, in this test's temp folder through TEMP). The model provider
 * reaches AIB's Codex through CODEX_CONFIG and the other Codex processes through `-c` flags; the owner's ~/.codex is checked untouched.
 *
 * "Another app" is the real Codex CLI with that same CODEX_HOME:
 *   - `codex exec resume <thread> -`: its command line names the thread and it waits for its prompt on stdin before it opens the
 *     thread, so it is there to be seen while AIB holds the thread; each prompt the test writes is a turn typed there;
 *   - `codex app-server` that resumes the thread over JSON-RPC: what VS Code's and Codex Desktop's Codex do; its command line names
 *     no thread, so only the thread's writer lock shows it holds the chat.
 *
 *   test_idle_chat_lets_go_and_comes_back_with_the_outside_turn
 *   test_running_turn_lets_go_only_after_the_turn
 *   test_still_held_waits_with_no_open_here_anyway
 *   test_vscode_app_server_lets_go_idle_chats_once
 *   test_app_server_does_not_touch_working_chat_or_unrelated_app_server
 *   test_let_go_button
 *
 * Skipped without node, codex-acp (AIB_CODEX_ACP) or Go (AIB_TEST_KEEPER_BIN names a built keeper). Targeted: run this file alone,
 * with TEMP/TMP pointed at a scratch folder with no space in its path.
 */
import { assert, assertEquals, isFile, Json, sleep, waitFor } from './_e2e.ts';
import { AibCodex, CODEX_ACP, HAVE_KEEPER_BIN, join, NODE_EXE, SERVER_SPLIT, Spawned, Stub, T, uuid } from './_e2e_real.ts';

const RELEASED_LINE = 'Continued in a terminal. AIB let go of this chat. Open it here to take it back.';

/** The codex executable codex-acp runs (its own @openai/codex package), or AIB_CODEX_CLI. */
function codexCli(): string | null {
  const named = Deno.env.get('AIB_CODEX_CLI');
  if (named) return named;
  if (!CODEX_ACP) return null;
  const parts = CODEX_ACP.split(/[\\/]/);
  const modules = parts.slice(0, parts.length - 4).join(Deno.build.os === 'windows' ? '\\' : '/'); // parents[3]
  const exe = join(modules, '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  return isFile(exe) ? exe : null;
}
const CODEX = codexCli();

function otherEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) if (!/^(OPENAI|CODEX|AIB_|AGENT_STUDIO)/i.test(k)) env[k] = v;
  for (const name of ['HOME', 'USERPROFILE']) env[name] = home;
  for (const name of ['TMP', 'TEMP', 'TMPDIR']) env[name] = join(home, 'tmp');
  env.CODEX_HOME = home;
  return env;
}

/** The stub model provider as `-c` overrides (AIB's chat gets the same through CODEX_CONFIG). */
function providerFlags(stub: Stub): string[] {
  const table = `{name="stub",base_url="${stub.url}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`;
  return ['-c', 'model="stub-model"', '-c', 'model_provider="stub"', '-c', `model_providers.stub=${table}`, '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false'];
}

const lockFile = (home: string, thread: string) => join(home, 'thread-writer-locks', `${thread}.lock`);
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The agent's throwaway CODEX_HOME (testHomeEnv): the one whose writer lock names the thread AIB holds. */
function agentHome(root: string, thread: string): string | null {
  try {
    for (const e of Deno.readDirSync(root)) {
      if (e.name.startsWith('agent-studio-test-home-') && exists(lockFile(join(root, e.name), thread))) return join(root, e.name);
    }
  } catch { /* none */ }
  return null;
}

/** `codex exec resume <thread> -` in the agent's CODEX_HOME: named on its command line, waiting for its prompt on stdin. */
class OtherCli {
  proc: Spawned;
  constructor(home: string, project: string, stub: Stub, thread: string) {
    this.proc = new Spawned(CODEX!, ['exec', '--skip-git-repo-check', '--json', ...providerFlags(stub), 'resume', thread, '-'], { cwd: project, env: otherEnv(home) });
  }
  get pid() {
    return this.proc.pid;
  }
  /** The turn typed there (its prompt; stdin closes, as the CLI reads it all). Returns what it said. */
  async say(text: string, wait = true): Promise<string> {
    await this.proc.write(text);
    await this.proc.closeStdin();
    if (!wait) return '';
    const code = await this.proc.waitExit(120);
    const said = this.proc.stdoutText();
    if (code !== 0) throw new Error(`the other Codex failed (${code}): ${said.slice(-1500)} ${this.proc.stderrText().slice(-2000)}`);
    return said;
  }
  stop() {
    return this.proc.stop();
  }
}

/** `codex app-server` (VS Code's and Codex Desktop's Codex) that resumes the thread over JSON-RPC and holds it until it quits. */
class OtherAppServer {
  proc!: Spawned;
  answers = new Map<number, Json>();
  next = 0;

  static async start(home: string, project: string, stub: Stub): Promise<OtherAppServer> {
    const app = new OtherAppServer();
    app.proc = new Spawned(CODEX!, [...providerFlags(stub), 'app-server'], {
      cwd: project,
      env: otherEnv(home),
      onStdoutLine: (line) => {
        try {
          const message = JSON.parse(line);
          if ('id' in message && ('result' in message || 'error' in message)) app.answers.set(message.id, message);
        } catch { /* not JSON */ }
      },
    });
    await app.call('initialize', { clientInfo: { name: 'Codex Desktop', version: '1.0' }, capabilities: { experimentalApi: true } });
    await app.send({ method: 'initialized' });
    return app;
  }
  send(message: Json) {
    return this.proc.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  async call(method: string, params: Json): Promise<Json> {
    const rid = ++this.next;
    await this.send({ id: rid, method, params });
    return await waitFor(() => this.answers.get(rid), `app-server ${method}`, 60);
  }
  stop() {
    return this.proc.stop();
  }
}

const FAKE_VSCODE_JS = `
// A stand-in for VS Code's extension host: this program (named Code.exe) starts the Codex extension's \`codex app-server\` and keeps it.
const { spawn } = require('child_process');
const [codex, ...args] = process.argv.slice(2);
const child = spawn(codex, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
child.on('exit', () => process.exit(0));
process.stdin.resume();
process.stdin.on('end', () => { child.kill(); process.exit(0); });
`;

/** `Code.exe script.js codex ... app-server`: the app-server's parent is a program called Code.exe, as under VS Code's extension host. */
class FakeVsCode {
  proc: Spawned;
  constructor(home: string, project: string, stub: Stub, parentName = 'Code.exe') {
    const folder = join(home, 'tmp', 'fake-' + uuid().slice(0, 8));
    Deno.mkdirSync(folder, { recursive: true });
    const exe = join(folder, parentName);
    Deno.copyFileSync(NODE_EXE!, exe);
    const script = join(folder, 'extension_host.js');
    Deno.writeTextFileSync(script, FAKE_VSCODE_JS);
    this.proc = new Spawned(exe, [script, CODEX!, ...providerFlags(stub), 'app-server'], { cwd: project, env: otherEnv(home) });
  }
  get pid() {
    return this.proc.pid;
  }
  stop() {
    return this.proc.stop();
  }
}

class World {
  aib!: AibCodex;
  disposables: { stop(): Promise<void> }[] = [];
  get chat() {
    return this.aib.chat;
  }
  get web() {
    return this.aib.web;
  }
  get stub() {
    return this.aib.stub;
  }
  get project() {
    return this.aib.project;
  }
  static async start(): Promise<World> {
    const w = new World();
    w.aib = await AibCodex.start([]); // no rules: every reply is the plain codeword reply
    return w;
  }
  track<T extends { stop(): Promise<void> }>(x: T): T {
    this.disposables.push(x);
    return x;
  }
  /** The mark: the owner guard looks for it in ~/.codex. */
  send(text: string, status = 200) {
    return this.chat.send(`${text} ${this.aib.mark}`, status);
  }
  async released() {
    return (((await this.chat.state()).elsewhere as Json | undefined) ?? {}).released === true;
  }
  async notesOf(kind: string): Promise<Json[]> {
    return (await this.chat.state(0)).events.filter((e) => e.kind === 'studio_note' && e.data.elsewhere === kind).map((e) => e.data);
  }
  /** One AIB turn, so Codex has written the thread; returns [thread id, its CODEX_HOME]. */
  async start(): Promise<[string, string]> {
    assert((await this.send('Remember: the codeword is ALPHA')).includes('STUB codeword=ALPHA'));
    const thread = await this.chat.session();
    const home = (await waitFor(() => agentHome(this.aib.temp.join('tmp'), thread), "the agent's CODEX_HOME", 30)) as string;
    Deno.mkdirSync(join(home, 'tmp'), { recursive: true });
    return [thread, home];
  }
  async dispose() {
    for (const d of this.disposables.reverse()) await d.stop();
    await this.aib?.dispose();
  }
  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
}

const ok = !!(NODE_EXE && CODEX_ACP && CODEX && HAVE_KEEPER_BIN && SERVER_SPLIT);
const t = (name: string, fn: (w: World) => Promise<void>) =>
  Deno.test({
    name: `CodexOpenElsewhereTest ${name}`,
    ignore: !ok,
    ...T,
    async fn() {
      await using w = await World.start();
      await fn(w);
    },
  });

const textOf = (e: { data: Json }) => String(((((e.data.update as Json).content) as Json).text) ?? '');

t('test_idle_chat_lets_go_and_comes_back_with_the_outside_turn', async (w) => {
  const [thread, home] = await w.start();
  assert(exists(lockFile(home, thread)), "AIB's Codex holds the thread's writer lock");
  await sleep(11000); // the 10 s beat ran: AIB's own Codex (app-server, hooks, shells) is never "elsewhere"
  assert(!('elsewhere' in (await w.chat.state())), 'AIB counted its own Codex as another app');

  const other = w.track(new OtherCli(home, w.project, w.stub, thread));
  const started = Date.now();
  await waitFor(() => w.released(), 'AIB to let go of the idle chat', 30);
  assert(Date.now() - started < 15000, 'letting go took too long');
  assertEquals((await w.notesOf('released')).map((n) => n.message), [RELEASED_LINE]);
  assertEquals((await w.notesOf('released'))[0].actions, [{ id: 'elsewhere-open', label: 'Open here' }]);
  await waitFor(() => !exists(lockFile(home, thread)), 'the writer lock to go (the thread unloaded at once)', 10);
  assert(!(await w.chat.state()).closed, 'the chat stays open in AIB (only the session was closed)');

  const said = await other.say(`Typed elsewhere: the codeword is BETA ${w.aib.mark}`);
  assert(said.includes('STUB codeword=BETA'), 'the other Codex opened the thread and wrote its turn');

  const reply = await w.send('What is the codeword now?');
  assert(reply.includes('STUB codeword=BETA'), 'the reloaded chat continues from the turn typed elsewhere');
  assert(!('elsewhere' in (await w.chat.state())));
  const users = (await w.chat.state(0)).events.filter((e) => e.kind === 'update' && (e.data.update as Json).sessionUpdate === 'user_message_chunk').map(textOf);
  assert(users.some((u) => u.includes('Typed elsewhere: the codeword is BETA')), JSON.stringify(users));
  assert(!users.some((u) => u.includes('Remember: the codeword is ALPHA')), 'AIB showed its own history again');
  assertEquals((await w.notesOf('back')).map((n) => n.message), ['AIB took this chat back, with 1 turn from a terminal above.']);
  assert(exists(lockFile(home, thread)), 'AIB holds the thread again');
});

t('test_running_turn_lets_go_only_after_the_turn', async (w) => {
  const [thread, home] = await w.start();
  const [status, sent] = await w.web.post('prompt', { id: w.chat.id, text: `STUB_WAIT=25 the codeword is GAMMA ${w.aib.mark}`, clientMessageId: uuid() });
  assertEquals(status, 200, JSON.stringify(sent));
  await waitFor(async () => (await w.chat.state()).busy, 'the turn to run');
  const other = w.track(new OtherCli(home, w.project, w.stub, thread));
  await waitFor(async () => (await w.chat.state()).elsewhere, 'AIB to notice the other Codex', 30);
  const state = await w.chat.state();
  assert(state.busy, 'the turn still runs');
  assert(!(state.elsewhere as Json).released, 'AIB waits for the turn before it lets go');
  assert(exists(lockFile(home, thread)), 'AIB still holds the thread while its turn runs');
  await waitFor(() => w.released(), 'AIB to let go after the turn', 60);
  const events = (await w.chat.state(0)).events;
  const said = events.filter((e) => e.kind === 'update' && (e.data.update as Json).sessionUpdate === 'agent_message_chunk').map(textOf).join('');
  assert(said.includes('STUB codeword=GAMMA'), 'the running turn finished with its reply');
  const ends = events.filter((e) => e.kind === 'turn_end').map((e) => e.data.stopReason);
  assertEquals(ends[ends.length - 1], 'end_turn');
  assertEquals((await w.notesOf('released')).length, 1);
  assert((await other.say(`the codeword is DELTA ${w.aib.mark}`)).includes('STUB codeword=DELTA'), 'the other Codex got the thread');
});

t('test_still_held_waits_with_no_open_here_anyway', async (w) => {
  const [thread, home] = await w.start();
  const cli = w.track(new OtherCli(home, w.project, w.stub, thread));
  await waitFor(() => w.released(), 'AIB to let go', 30);
  await cli.say('', false); // an empty prompt: that CLI gives up and quits without opening the thread
  await waitFor(() => cli.proc.exited, 'the CLI to quit', 60);
  const app = w.track(await OtherAppServer.start(home, w.project, w.stub));
  const resumed = await app.call('thread/resume', { threadId: thread });
  assert(!('error' in resumed), JSON.stringify(resumed));
  assert(exists(lockFile(home, thread)), 'the app-server client holds the thread');

  const calls = w.stub.calls().length;
  const refused = (await w.send('Are you there?', 409)) as unknown as Json;
  assertEquals(refused.code, 'held_elsewhere');
  assertEquals(refused.error, 'This chat is still open in another app, so nothing was sent. Close it there, then send again.');
  const held = await w.notesOf('held');
  assertEquals(held.map((n) => n.message), [
    'Still open in another app. Close it there first, then choose Open here (Codex lets only one app write to a chat at a time).',
  ]);
  assertEquals(held[0].actions, [{ id: 'elsewhere-open', label: 'Open here' }], 'no Open here anyway for Codex');
  assertEquals((await w.web.post('prompt', { id: w.chat.id, text: 'Again?', clientMessageId: uuid() }))[0], 409);
  assertEquals((await w.notesOf('held')).length, 1, 'a second try adds no second line');
  assertEquals(w.stub.calls().length, calls, 'nothing was sent while another app holds the chat');
  for (const force of [false, true]) { // Codex refuses a second writer: forcing changes nothing
    const [status, answer] = await w.web.post('session-op', { id: w.chat.id, op: 'open-here', force });
    assertEquals([status, answer.state], [200, 'held'], JSON.stringify(answer));
  }
  assert(await w.released());

  await app.stop();
  await waitFor(() => !exists(lockFile(home, thread)), 'the app-server client to let go', 20);
  const [status, answer] = await w.web.post('session-op', { id: w.chat.id, op: 'open-here' });
  assertEquals([status, answer.state], [200, 'back'], JSON.stringify(answer));
  assert(!('elsewhere' in (await w.chat.state())));
  assert((await w.send('and the codeword?')).includes('STUB codeword=ALPHA'));
});

t('test_vscode_app_server_lets_go_idle_chats_once', async (w) => {
  const [thread, home] = await w.start();
  await sleep(11000); // AIB's own app-server is never counted
  assert(!('elsewhere' in (await w.chat.state())), "AIB counted its own app-server as VS Code's");
  w.track(new FakeVsCode(home, w.project, w.stub));
  const started = Date.now();
  await waitFor(() => w.released(), "AIB to let go when VS Code's Codex started", 30);
  assert(Date.now() - started < 15000);
  const line = "VS Code's Codex started: AIB let go so you can open this chat there. Open it here to take it back.";
  assertEquals((await w.notesOf('released')).map((n) => n.message), [line]);
  assertEquals((await w.notesOf('released'))[0].actions, [{ id: 'elsewhere-open', label: 'Open here' }]);
  await waitFor(() => !exists(lockFile(home, thread)), 'the writer lock to go', 10);
  assert(!(await w.chat.state()).closed);

  assert((await w.send('What is the codeword?')).includes('STUB codeword=ALPHA'), 'sending takes the chat back');
  assert(!('elsewhere' in (await w.chat.state())));
  assert(exists(lockFile(home, thread)), 'AIB holds the thread again');
  await sleep(12000); // a beat: that same app-server (pid and start) does not make AIB let go again
  assert(!('elsewhere' in (await w.chat.state())));
  assertEquals((await w.notesOf('released')).length, 1);
});

t('test_app_server_does_not_touch_working_chat_or_unrelated_app_server', async (w) => {
  const [thread, home] = await w.start();
  w.track(new FakeVsCode(home, w.project, w.stub, 'script_runner.exe')); // not an editor
  await sleep(13000);
  assert(!('elsewhere' in (await w.chat.state())), "an app-server a script started is not VS Code's");
  assert(exists(lockFile(home, thread)));

  const [status, sent] = await w.web.post('prompt', { id: w.chat.id, text: `STUB_WAIT=25 the codeword is GAMMA ${w.aib.mark}`, clientMessageId: uuid() });
  assertEquals(status, 200, JSON.stringify(sent));
  await waitFor(async () => (await w.chat.state()).busy, 'the turn to run');
  w.track(new FakeVsCode(home, w.project, w.stub));
  await sleep(14000); // at least one beat while the turn runs
  const state = await w.chat.state();
  assert(state.busy, 'the turn still runs');
  assert(!('elsewhere' in state), 'a working chat is never let go for an app-server (and nothing waits for its turn)');
  assert(exists(lockFile(home, thread)));
  await waitFor(async () => !(await w.chat.state()).busy, 'the turn to end', 60);
  await sleep(12000);
  assert(!('elsewhere' in (await w.chat.state())), 'once seen, that app-server does not act when the turn ends');
  assert((await w.send('and the codeword?')).includes('STUB codeword=GAMMA'));
});

t('test_let_go_button', async (w) => {
  const [thread, home] = await w.start();
  let [status, answer] = await w.web.post('session-op', { id: w.chat.id, op: 'let-go' });
  assertEquals([status, answer.state], [200, 'released'], JSON.stringify(answer));
  assert(await w.released());
  assertEquals((await w.notesOf('released')).map((n) => n.message), ['AIB let go of this chat so another app can open it. Open it here to take it back.']);
  await waitFor(() => !exists(lockFile(home, thread)), 'the writer lock to go', 10);
  [status, answer] = await w.web.post('session-op', { id: w.chat.id, op: 'let-go' });
  assertEquals([status, answer.state], [200, 'already'], JSON.stringify(answer));
  [status, answer] = await w.web.post('session-op', { id: w.chat.id, op: 'open-here' });
  assertEquals([status, answer.state], [200, 'back'], JSON.stringify(answer));
  assert(!('elsewhere' in (await w.chat.state())));
  assert(exists(lockFile(home, thread)));

  const [s2, sent] = await w.web.post('prompt', { id: w.chat.id, text: `STUB_WAIT=20 the codeword is GAMMA ${w.aib.mark}`, clientMessageId: uuid() });
  assertEquals(s2, 200, JSON.stringify(sent));
  await waitFor(async () => (await w.chat.state()).busy, 'the turn to run');
  [status, answer] = await w.web.post('session-op', { id: w.chat.id, op: 'let-go' });
  assertEquals([status, answer.state], [200, 'busy'], JSON.stringify(answer));
  assertEquals(answer.message, 'This chat is working, so AIB did not let go. Try again when it is idle.');
  assert(!('elsewhere' in (await w.chat.state())), 'nothing was let go and nothing waits');
  assert(exists(lockFile(home, thread)));
});
