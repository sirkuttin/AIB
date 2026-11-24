/**
 * Background tasks, the ownership check and busy-children detection of WSL chats (docs/WSL.md "Background tasks and ownership"),
 * without a distro: the helper's methods (wsl/helper/bgtasks.ts) on temp folders with a stand-in process list, and the Windows side
 * (wsl/transcripts.ts, wsl/procs.ts, wsl/ownership.ts, Studio.connect, Connection) through a FakeWslHost (a real keeper standing in
 * for the distro's). The real distro: wsl_bgtasks_e2e_test.ts.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { agentNamed, bgtaskMethods } from '../../app/server/wsl/helper/bgtasks.ts';
import { Store } from '../../app/server/transcripts/store.ts';
import type { ProcInfo } from '../../app/server/ownership/probe.ts';
import { OwnershipConflict } from '../../app/server/ownership/ownership.ts';
import { folderOnlyNote, OwnershipEvidence } from '../../app/server/ownership/probe.ts';
import { wslTranscriptGet } from '../../app/server/wsl/transcripts.ts';
import { parseQs } from '../../app/server/transcripts/pycompat.ts';
import { FRESH_MS, refreshWslDescendants, resetWslProcs, wslDescendants } from '../../app/server/wsl/procs.ts';
import { descendants, refreshDescendants } from '../../app/server/platform/descendants.ts';
import { processList } from '../../app/server/platform/process_info.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';
const WSL_ROOT = '/tmp/aib-wsl-test-bgtasks';
Deno.env.set('AIB_WSL_ROOT', WSL_ROOT);

const join = (...parts: string[]) => parts.join(SEP);
const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

/** A Claude projects folder with one session that started a background Bash command, and its task output under `tmp/claude`. */
function fixture(dir: string, session = 'sess-1'): { projects: string; tmp: string; key: string } {
  const projects = join(dir, 'projects');
  const tmp = join(dir, 'tmp');
  Deno.mkdirSync(join(projects, 'proj'), { recursive: true });
  const rows = [
    { type: 'user', sessionId: session, cwd: '/home/u/app', timestamp: iso(30), message: { role: 'user', content: 'run the tests' } },
    {
      type: 'assistant',
      sessionId: session,
      timestamp: iso(20),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test', description: 'Tests', run_in_background: true } }] },
    },
    {
      type: 'user',
      sessionId: session,
      timestamp: iso(19),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Command running in background with ID: job1.' }] },
      toolUseResult: { backgroundTaskId: 'job1' },
    },
  ];
  Deno.writeTextFileSync(join(projects, 'proj', `${session}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  Deno.mkdirSync(join(tmp, 'claude', 'proj', session, 'tasks'), { recursive: true });
  Deno.writeTextFileSync(join(tmp, 'claude', 'proj', session, 'tasks', 'job1.output'), 'PASS 12 tests\n');
  return { projects, tmp, key: `proj/${session}.jsonl` };
}

function helper(projects: string, processes: () => ProcInfo[] = () => []) {
  return bgtaskMethods({
    env: () => Promise.resolve({ env: {}, home: '/home/u' }),
    store: async () => await Store.open(projects),
    processes,
    holders: () => [],
  });
}

Deno.test('helper transcripts.query: the background commands of a saved session, their output, the agents with running counts', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-bg-' });
  try {
    const { projects, tmp, key } = fixture(dir);
    const m = helper(projects);
    const list = await m['transcripts.query']({ provider: 'claude', path: '/api/commands', key }) as { status: number; body: Json };
    assertEquals(list.status, 200, JSON.stringify(list.body));
    assertEquals(list.body.running, 1);
    const [task] = list.body.commands as Json[];
    assertEquals([task.id, task.status, task.jobId], [`${key}#c1`, 'running', 'job1']);
    const one = await m['transcripts.query']({ provider: 'claude', path: '/api/command', key, args: { id: String(task.id) }, tempDir: tmp }) as { status: number; body: Json };
    assertEquals(one.status, 200);
    assert(String(one.body.output).includes('PASS 12 tests'), String(one.body.output));
    const agents = await m['transcripts.query']({ provider: 'claude', path: '/api/agents', key }) as { body: { agents: Json[] } };
    assertEquals(agents.body.agents.map((a) => [a.main, a.runningCommands]), [[true, 1]]);
    const unknown = await m['transcripts.query']({ provider: 'claude', path: '/api/command', key, args: { id: 'nope' } }) as { status: number };
    assertEquals(unknown.status, 400);
    await assertRejects(() => Promise.resolve(m['transcripts.query']({ provider: 'claude', path: '/api/transcript', key })));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('helper ownership.check: a claude process naming the session owns it; AIB-excluded trees and other sessions never do', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-own-' });
  try {
    const { projects } = fixture(dir, 'sess-1');
    let procs: ProcInfo[] = [];
    const m = helper(projects, () => procs);
    const check = async (sessionId: string, extra: Json = {}) =>
      await m['ownership.check']({ provider: 'claude', sessionId, claudeDir: dir, ...extra }) as { owner: number | null; assessment: Json };
    procs = [
      { pid: 50, ppid: 1, name: 'claude', cmdline: '/bin/sh /tmp/x/claude --resume sess-1', cwd: '/elsewhere' },
      { pid: 60, ppid: 1, name: 'python3', cmdline: 'python3 agent.py', cwd: '/home/u/app' }, // AIB's own agent channel
      { pid: 61, ppid: 60, name: 'claude', cmdline: 'claude --resume sess-2 --output-format stream-json', cwd: '/home/u/app' },
    ];
    assertEquals((await check('sess-1')).owner, 50);
    assertEquals((await check('sess-2', { exclude: [60] })).owner, null, "AIB's own agent and what it started never own a session");
    assertEquals((await check('sess-2')).owner, 61);
    assertEquals((await check('sess-3')).owner, null);
    // the transcript was written 19 s ago by someone else: weak; written before AIB released it: AIB's own
    Deno.utimeSync(join(projects, 'proj', 'sess-1.jsonl'), new Date(), new Date());
    procs = [];
    assertEquals((await check('sess-1')).assessment.verdict, 'possibly_active');
    assertEquals((await check('sess-1', { releasedAgo: 0 })).assessment.verdict, 'no_evidence');
    assertEquals((await check('sess-1', { releasedAgo: 0 })).assessment.certainty, 'checked');
    // a Claude Code panel (no session id) in the chat's folder: folder-only evidence once the transcript is quiet for 30 minutes
    // (sess-4: a chat AIB never released here, so every write counts as another app's)
    fixture(dir, 'sess-4');
    procs = [{ pid: 70, ppid: 1, name: 'claude', cmdline: 'claude --output-format stream-json --verbose', cwd: '/home/u/app' }];
    const back = (minutes: number) => {
      const when = new Date(Date.now() - minutes * 60_000);
      Deno.utimeSync(join(projects, 'proj', 'sess-4.jsonl'), when, when);
    };
    back(31);
    const quiet = await check('sess-4', { cwd: '/home/u/app' });
    assertEquals([quiet.owner, quiet.assessment.verdict, quiet.assessment.transcriptQuiet], [null, 'possibly_active', true]);
    assertEquals(folderOnlyNote(quiet.assessment), 'Claude Code is also running in this folder (PID 70). AIB found nothing that says it holds this conversation.');
    back(29);
    const recent = await check('sess-4', { cwd: '/home/u/app' });
    assertEquals([recent.assessment.verdict, recent.assessment.transcriptQuiet, folderOnlyNote(recent.assessment)], ['possibly_active', false, null]);
    await assertRejects(() => Promise.resolve(m['ownership.check']({ provider: 'claude', sessionId: 's', exclude: ['x'] })));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('helper agentNamed: Claude Code is found by the name it was started as, not its /proc exe (node, a version file)', () => {
  const base = { pid: 7, ppid: 1, cwd: null };
  assertEquals(agentNamed({ ...base, name: '2.1.3', cmdline: '/home/u/.local/bin/claude --resume s' }, () => '').name, 'claude');
  assertEquals(agentNamed({ ...base, name: 'node', cmdline: 'claude' }, () => 'claude').name, 'claude');
  assertEquals(agentNamed({ ...base, name: 'node', cmdline: 'node /x/claude-agent-acp/dist/index.js' }, () => 'node').name, 'node');
  assertEquals(agentNamed({ ...base, name: 'dash', cmdline: '/bin/sh /tmp/x/claude --resume s' }, () => 'claude').name, 'claude');
});

Deno.test({
  name: 'wsl viewer: commands, output and agents of a WSL session come from its helper with WSL keys; a distro away says so',
  ...T,
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-bgview-' });
    const host = new FakeWslHost(join(dir, 'linux-keeper'));
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    try {
      const { projects, tmp, key } = fixture(dir);
      const m = helper(projects);
      const seen: Json[] = [];
      host.handlers['transcripts.query'] = (p) => {
        seen.push(p);
        return m['transcripts.query']({ ...p, tempDir: tmp }); // the Linux temp folder AIB named stands for this one
      };
      const wslKey = `wsl.ubuntu.claude/${key}`;
      const get = (path: string, query: string) => wslTranscriptGet(path, parseQs(query));
      const list = await get('/api/commands', `session=${encodeURIComponent(wslKey)}`);
      assertEquals(list?.status, 200, JSON.stringify(list?.body));
      const body = list!.body as { commands: Json[]; running: number };
      assertEquals(body.running, 1);
      assertEquals([body.commands[0].id, body.commands[0].agentKey], [`${wslKey}#c1`, wslKey]);
      // under test the helper reads the task output and transcripts inside AIB_WSL_ROOT, never the distro's /tmp or ~/.claude
      assertEquals([seen[0].key, seen[0].path, seen[0].tempDir, seen[0].claudeDir], [key, '/api/commands', `${WSL_ROOT}/tmp`, `${WSL_ROOT}/home/.claude`]);
      const one = await get('/api/command', `session=${encodeURIComponent(wslKey)}&id=${encodeURIComponent(String(body.commands[0].id))}`);
      assertEquals(one?.status, 200, JSON.stringify(one?.body));
      assert(String((one!.body as Json).output).includes('PASS 12 tests'));
      assertEquals((one!.body as Json).id, `${wslKey}#c1`);
      assertEquals((seen.at(-1)!.args as Json).id, `${key}#c1`, 'the helper gets its own id back');
      const agents = await get('/api/agents', `session=${encodeURIComponent(wslKey)}`);
      assertEquals(((agents!.body as Json).agents as Json[]).map((a) => [a.key, a.runningCommands]), [[wslKey, 1]]);
      assertEquals((await get('/api/command', `session=${encodeURIComponent(wslKey)}&id=other%23c1`))?.status, 400);
      // a picture of a saved WSL chat: said plainly (never the Windows transcript lookup)
      const image = await get('/api/transcript/image', `key=${encodeURIComponent(wslKey)}&n=1&i=0`);
      assertEquals([image?.status, (image?.body as Json).code], [404, 'wsl_image']);

      // the distro is not running: never started for a poll; the page is told why instead of "nothing runs"
      host.state = 'stopped';
      const calls = host.calls.length;
      const away = await get('/api/commands', `session=${encodeURIComponent(wslKey)}`);
      assertEquals([away?.status, (away?.body as Json).error], [400, 'Ubuntu stopped. Reconnect']);
      const roster = await get('/api/agents', `session=${encodeURIComponent(wslKey)}`);
      assertEquals([roster?.status, (roster?.body as Json).unavailable], [200, 'Ubuntu stopped. Reconnect']);
      assertEquals(host.calls.length, calls, 'no helper call');
      // an older helper without the method: the same
      host.state = 'ready';
      delete host.handlers['transcripts.query'];
      const old = await get('/api/commands', `session=${encodeURIComponent(wslKey)}`);
      assertEquals(old?.status, 400);
      assert(String((old?.body as Json).error).includes('transcripts.query'), JSON.stringify(old?.body));
    } finally {
      setWslHostResolver(null);
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: 'wsl procs: snapshots come from the helper, a few seconds old at most; a helper away answers null (still running), never []',
  ...T,
  async fn() {
    resetWslProcs();
    const host = new FakeWslHost(Deno.makeTempDirSync({ prefix: 'aib-wsl-procs-' }));
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    let rows: [number, number, number, number | null][] = [[101, 100, 1, 5], [102, 101, 2, null]];
    host.handlers['proc.tree'] = (p) => ({ trees: Object.fromEntries((p.roots as number[]).map((r) => [String(r), r === 100 ? rows : null])) });
    try {
      assertEquals(wslDescendants('ubuntu', 100), null, 'nothing known yet: a fetch starts');
      await refreshWslDescendants('ubuntu', 100);
      const now = wslDescendants('ubuntu', 100)!;
      assertEquals(now.map((d) => [d.pid, d.parentPid, d.depth]), [[101, 100, 1], [102, 101, 2]]);
      assert(Math.abs(now[0].started! - (Date.now() / 1000 - 5)) < 2);
      assertEquals(now[1].started, null);
      assertEquals(wslDescendants('ubuntu', 100, Date.now() + 1), null, 'a snapshot from before the command started is not used');
      rows = [];
      await refreshWslDescendants('ubuntu', 100);
      assertEquals(wslDescendants('ubuntu', 100), [], 'the processes ended');
      host.state = 'stopped';
      await pause(FRESH_MS + 200);
      assertEquals(wslDescendants('ubuntu', 100), null, 'too old, and the helper is away');
      await refreshWslDescendants('ubuntu', 100);
      assertEquals(wslDescendants('ubuntu', 100), null);
    } finally {
      setWslHostResolver(null);
      resetWslProcs();
    }
  },
});

// ---- Studio and Connection over a FakeWslHost -----------------------------------------------------------------------------------

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-bgstudio-' }));
  readonly state = join(this.dir, 'state');
  readonly work = join(this.dir, 'app');
  readonly host: FakeWslHost;
  readonly studios: Aib[] = [];

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    this.host = new FakeWslHost(join(this.dir, 'linux-keeper'));
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u', this.dir);
    // the fake's "Linux" agents are Windows processes: its proc.tree is platform/descendants.ts here, as the helper's is in a distro
    // (without the console hosts Windows gives a console program, which a distro has no counterpart of)
    this.host.handlers['proc.tree'] = (p) => {
      refreshDescendants();
      const conhosts = new Set(processList().filter((e) => e.exe.toLowerCase() === 'conhost.exe').map((e) => e.pid));
      return {
        trees: Object.fromEntries((p.roots as number[]).map((root) => {
          const found = descendants(root)?.filter((d) => !conhosts.has(d.pid)) ?? null;
          const now = Date.now() / 1000;
          return [String(root), found ? found.map((d) => [d.pid, d.parentPid, d.depth, d.started === null ? null : now - d.started]) : null];
        })),
      };
    };
    // and its proc.stop the helper's own method (platform/kill_verified.ts, which on Windows terminates through a verified handle)
    this.host.handlers['proc.stop'] = (p) => helper(this.dir)['proc.stop'](p);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
    resetWslProcs();
  }

  studio(flags: string[] = []): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Aib({ stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => {
      throw new Error('a WSL chat never asks Windows for its owner');
    };
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware', ...flags), cwd, provider, { ...options, wsl });
    };
    this.studios.push(studio);
    return studio;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    resetWslProcs();
    await this.host.stopKeeper();
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

function assessment(sessionId: string, verdict: string, reasons: Json[] = []): Json {
  return { provider: 'claude', sessionId, reasons, notes: [], unavailable: [], checkedAt: 0, verdict, summary: '', certainty: 'evidence' };
}

Deno.test({
  name: 'wsl continue: a process in the distro holding the session is refused with the Windows words; AIB agents are excluded',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const studio = lab.studio();
    const other = await studio.connect('claude', REF); // another chat of this AIB, still open: its agent must be excluded
    const sessionId = 'saved-1'; // a saved chat of the distro (the fake agent loads any id)

    const asked: Json[] = [];
    let answer: Json = { owner: 4321, assessment: assessment(sessionId, 'no_evidence') };
    lab.host.handlers['ownership.check'] = (p) => (asked.push(p), answer);
    const refused = await assertRejects(() => studio.connect('claude', REF, sessionId), OwnershipConflict);
    assertEquals(
      refused.message,
      'This claude conversation is already open in another agent process (PID 4321). Stop it in its current client before continuing here.',
    );
    assertEquals([asked[0].provider, asked[0].sessionId, asked[0].cwd], ['claude', sessionId, '/home/u/app']);
    assert((asked[0].exclude as number[]).includes(other.process!.pid), `own agent excluded: ${JSON.stringify(asked[0])}`);
    assertEquals(asked[0].releasedAgo, undefined, 'never released by this AIB');

    // weak evidence asks first, as on Windows; continueAnyway goes on
    answer = {
      owner: null,
      assessment: assessment(sessionId, 'possibly_active', [{ signal: 'transcript', strength: 'weak', text: 'Transcript was written 3 seconds ago, and AIB is not the app writing it.' }]),
    };
    const asks = await assertRejects(() => studio.connect('claude', REF, sessionId), OwnershipEvidence) as OwnershipEvidence;
    assertEquals(asks.code, 'possibly_active');
    assert(asks.message.startsWith('Another app may be using this conversation: Transcript was written'), asks.message);
    const going = await studio.connect('claude', REF, sessionId, { continueAnyway: true });
    assert(going.ready && !going.closed);
    await going.close();
    studio.evictClosed();
    // folder-only evidence (a Claude Code panel in the folder, transcript quiet 30 minutes): continues with one note, as on Windows
    const panelReason = {
      signal: 'process-folder',
      strength: 'weak',
      pid: 777,
      label: 'Claude Code',
      startedBy: 'VS Code',
      text: 'Claude Code (PID 777, started by VS Code) is running in this project folder. Agent processes do not reveal which conversation they hold, so AIB cannot tell whether it is this one.',
    };
    answer = { owner: null, assessment: { ...assessment(sessionId, 'possibly_active', [panelReason]), transcriptQuiet: true } };
    const noted = await studio.connect('claude', REF, sessionId);
    assert(noted.ready && !noted.closed);
    assertEquals(
      (noted.public().events as Json[]).filter((e) => e.kind === 'studio_note').map((e) => (e.data as Json).message),
      ['Claude Code is also running in this folder (PID 777, started by VS Code). AIB found nothing that says it holds this conversation.'],
    );
    await noted.close();
    studio.evictClosed();
    // the same reason without a quiet transcript (or from an older helper without the field): asks
    answer = { owner: null, assessment: assessment(sessionId, 'possibly_active', [panelReason]) };
    const unsure = await assertRejects(() => studio.connect('claude', REF, sessionId), OwnershipEvidence) as OwnershipEvidence;
    assertEquals(unsure.code, 'possibly_active');

    answer = { owner: null, assessment: assessment(sessionId, 'no_evidence') };
    const again = await studio.connect('claude', REF, sessionId);
    assertEquals(typeof asked.at(-1)!.releasedAgo, 'number', 'AIB just released it: its own transcript writes are not evidence');
    await again.close();
    studio.evictClosed();

    // a helper without the method (an older one): the check falls back to the registry, never a refusal it cannot explain
    delete lab.host.handlers['ownership.check'];
    const opened = await studio.connect('claude', REF, sessionId);
    assert(opened.ready && !opened.closed);
    // the detail query of a WSL folder goes to the distro too (here: AIB itself holds it)
    assertEquals(((await studio.ownershipQuery('claude', sessionId, REF)) as Json).verdict, 'owned_by_studio');
  },
});

Deno.test({
  name: 'wsl chat: a background shell keeps the chat out of idle while it runs in the distro, also while the helper is away',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const studio = lab.studio(['--held-turn']);
    const c = await studio.connect('claude', REF);
    const gate = join(lab.dir, 'gate');
    assertEquals((await studio.liveCall('prompt', { id: c.id, text: `bgshell:${gate}`, clientMessageId: 'm1' }))[0], 200);
    await until(() => !c.busy && c.events.some((e) => e.kind === 'turn_end'), 'the reply ended', 30);
    await until(() => c.backgroundShells().length === 1, 'the shell counts', 15);
    await until(() => lab.host.calls.some(([m]) => m === 'proc.tree'), 'asked the distro', 10);
    assertEquals(studio.busyList().map((b) => b.state), ['background']);
    // Stop is offered once the distro's snapshot named the command's processes
    await until(() => Object.values(c.toolBackground())[0]?.stoppable, 'Stop offered', 10);
    assertEquals(Object.values(c.toolBackground())[0].state, 'running');

    // the helper goes away: unknown, so it still counts (never a wrong idle)
    lab.host.state = 'stopped';
    await pause(FRESH_MS + 500);
    assertEquals(c.backgroundShells(), ['bfake1']);
    assertEquals(studio.busyList().map((b) => b.state), ['background']);
    lab.host.state = 'ready';

    Deno.writeTextFileSync(gate, 'go'); // the command ends
    await until(() => studio.busyList().length === 0, 'the chat dropped out of the busy list', 30);
    assertEquals(c.backgroundShells(), []);
    assertEquals(Object.values(c.toolBackground())[0].state, 'done');
  },
});

Deno.test('helper proc.stop: refuses bad params; a pid that is not below the agent, or has another start time, is never signalled', async () => {
  const m = helper('/nowhere', () => []);
  for (const bad of [{ root: 1, targets: [[5, 1]] }, { root: Deno.pid, targets: [[5, 1]] }, { root: 9, targets: [] }, { root: 9, targets: [[5, -1]] }, { root: 9, targets: [5] }]) {
    await assertRejects(() => Promise.resolve(m['proc.stop'](bad)));
  }
  const python = fake()[0];
  const spawn = () => new Deno.Command(python, { args: ['-c', 'import time; time.sleep(60)'], stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
  const root = spawn(), unrelated = spawn();
  const sent: number[] = [];
  const watched = bgtaskMethods({ env: () => Promise.resolve({ env: {}, home: '/' }), store: () => Promise.resolve(null), killer: (t) => (sent.push(t.pid), true) });
  try {
    const answer = await watched['proc.stop']({ root: root.pid, targets: [[unrelated.pid, 0]] }) as Json;
    assertEquals([answer.listed, answer.killed, answer.skipped, sent], [true, [], [unrelated.pid], []]);
  } finally {
    for (const p of [root, unrelated]) {
      p.kill();
      await p.status;
    }
  }
});

Deno.test({
  name: 'wsl chat: Stop on a background row ends the command in the distro (its processes only) and the row shows stopped',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const pidFile = join(lab.dir, 'child');
    const studio = lab.studio(['--held-turn', '--child-pid-file', pidFile]);
    const c = await studio.connect('claude', REF);
    const gate = join(lab.dir, 'gate');
    assertEquals((await studio.liveCall('prompt', { id: c.id, text: `bgshell:${gate}`, clientMessageId: 'm1' }))[0], 200);
    await until(() => Object.values(c.toolBackground())[0]?.stoppable, 'Stop offered', 30);
    const shell = Number(Deno.readTextFileSync(pidFile + '.shell'));
    const agentChild = Number(Deno.readTextFileSync(pidFile)); // started with the agent, before the turn: never the command's
    const toolId = Object.keys(c.toolBackground())[0];
    assert(pidAlive(shell) && pidAlive(agentChild));

    // a reused pid (the shell's pid, another start time) is not the command: nothing is signalled
    const reused = await lab.host.call('proc.stop', { root: c.process!.pid, targets: [[shell, 3600]] });
    assertEquals([reused.listed, reused.killed, reused.skipped], [true, [], [shell]]);
    assert(pidAlive(shell));

    const [status, body] = await studio.liveCall('tool-stop', { id: c.id, toolCallId: toolId }) as [number, Json];
    assertEquals([status, body.state, body.killed], [200, 'stopped', 1], JSON.stringify(body));
    const stops = lab.host.calls.filter(([m]) => m === 'proc.stop');
    assertEquals(((stops.at(-1)![1] as Json).targets as [number, number][]).map(([pid]) => pid), [shell], 'only the noted process');
    await until(() => !pidAlive(shell), 'the shell ended', 10);
    assert(pidAlive(agentChild), "the agent's own child is untouched");
    assertEquals(Object.values(c.toolBackground())[0], { state: 'stopped', stoppable: false });
    await until(() => studio.busyList().length === 0, 'the chat dropped out of the busy list', 15);
    const again = await studio.liveCall('tool-stop', { id: c.id, toolCallId: toolId });
    assertEquals(again[0], 409);
  },
});
