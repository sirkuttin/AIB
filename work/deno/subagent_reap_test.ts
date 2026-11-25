/**
 * No stuck processes, Slice 0, build steps 5 and 6: a finished subagent's processes are shut down (server/subagents/reap.ts,
 * server/platform/proc_env.ts, server/subagents/service.ts). Fake agents plus the REAL hook forwarder in front of the real subagent routes
 * (as subagent_shell_tag_test.ts), real processes in a real shell, headless, temp folders. Every wait has a hard limit.
 *   a subagent starts a tagged background process (detached, a child under it), then finishes: all gone within seconds, row grey, one line
 *   TaskStop of ONE call kills only that call's processes; the subagent's other call keeps running until it finishes
 *   never killed: untagged lookalikes, another subagent's, the main chat's, another chat's, anything that started before its call
 *   a pid reused between the scan and the kill (or a process older than the subagent) is left alone
 *   Codex subagent: the same as the first
 *   the Activity rows of calls AIB shut down read "stopped: subagent finished"
 *   WSL (real distro, AIB_WSL_E2E=<distro>; skipped without it): hook 2 tags the subagent's call through the Linux keeper, the helper's reaper
 *     shuts its processes down over /proc, AIB posts the line once; another subagent's cookie is left alone
 */
import { assert, assertEquals } from './_assert.ts';
import { configure, issueHookKey } from '../../app/server/artifacts/keys.ts';
import { ArtifactMcpHttp } from '../../app/server/artifacts/mcp_http.ts';
import { keeperBinary } from '../../app/server/keeper/client.ts';
import { gitBashPath } from '../../app/server/subagents/claude_config.ts';
import { codexHook } from '../../app/server/subagents/codex.ts';
import { FILE, type SubagentChat, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { ProcessReaper, reapedWhyIn, recordReaped } from '../../app/server/subagents/reap.ts';
import { type ProcSource, realProcesses, type Seen, type Tagged, taggedSince } from '../../app/server/platform/proc_env.ts';
import { processStrings } from '../../app/server/platform/process_info.ts';
import { killProcesses } from '../../app/server/platform/kill_verified.ts';
import { cookieIn } from '../../app/server/platform/proc_env.ts';
import { cookieOf, stripAibPrefix, stripAibPrefixes, tagPrefix } from '../../app/server/allow/aib_prefix.ts';
import { OWN_WORK } from '../../app/server/subagents/own_work.ts';
import { parseCookie } from '../../app/server/subagents/shell_tag.ts';
import { join } from '../../app/server/platform/path.ts';
import * as m from '../../app/server/transcripts/monitor.ts';
import * as fx from './_monitor_fixtures.ts';

type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const T = { sanitizeResources: false, sanitizeOps: false };
const DEC = new TextDecoder();
// These tests run real shells and read their cookies. When the suite itself runs inside an AIB-tagged shell (an AIB agent running tests), every
// child inherits that shell's AIB_PROC and PATH marker, so a process given another cookie reads as ambiguous (untagged) and is never found.
// Start from an untagged environment.
Deno.env.delete('AIB_PROC');
{
  const sep = Deno.build.os === 'windows' ? ';' : ':';
  Deno.env.set('PATH', (Deno.env.get('PATH') ?? '').split(sep).filter((e) => !/[\\/]aibproc[\\/]/.test(e)).join(sep));
}
const BASH = gitBashPath(Deno.env.toObject()) ?? 'bash';
const CHAT = '5ea9c0de00aa11bb22cc33dd44ee5501';
const OTHER_CHAT = 'deadbeef00112233445566778899aabb';
/** This run's own sleep durations: the sweep at the end of a test finds its leftovers by them and touches nothing else. */
const NUM = 30000 + Math.floor(Math.random() * 20000);
const PAIR = `sleep ${NUM} & sleep ${NUM + 1}`;

// A finished subagent that still has processes is left alone until its ceiling (subagents/own_work.ts, 2026-11-24: builders landed under
// their running tests). These tests are about the shutdown itself, which is what happens at the ceiling: it is zero here.
OWN_WORK.ceilingS = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (hard limit) until `fn` holds. */
async function until(what: string, fn: () => boolean | Promise<boolean>, limitMs = 25_000): Promise<void> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`gave up waiting (${limitMs} ms) for: ${what}`);
}

/** Processes carrying a cookie of this chat and owner (and call), from one snapshot. */
function carrying(chat: string, owner?: string, call?: string): Tagged[] {
  const found = taggedSince(Date.now() / 1000 - 300);
  return (found?.tagged ?? []).filter((p) => {
    const c = parseCookie(p.cookie);
    return !!c && c.chat === chat && (owner === undefined || c.owner === owner) && (call === undefined || c.call === call);
  });
}

function alive(pid: number, started: number): boolean {
  const now = realProcesses.list(0)?.find((p) => p.pid === pid);
  return !!now && Math.abs(now.started - started) < 3;
}

function git(cwd: string, ...args: string[]): void {
  const out = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${DEC.decode(out.stderr)}`);
}

/** Ends whatever this run's tests left that carries their own sleep durations (the look-alikes the tests keep alive on purpose). */
async function sweepLeftovers(since: number): Promise<void> {
  if (!WIN) {
    new Deno.Command('pkill', { args: ['-f', `sleep (${NUM}|${NUM + 1})$`], stdout: 'null', stderr: 'null' }).outputSync();
    return;
  }
  const mine = new RegExp(`sleep(\\.exe)?"?\\s+(${NUM}|${NUM + 1})\\b`, 'i');
  const doomed = (realProcesses.list(since - 5) ?? []).filter((p) => mine.test(processStrings(p.pid)?.commandLine ?? ''));
  await killProcesses(doomed.map((p) => ({ pid: p.pid, started: p.started })));
}

interface Run {
  code: number;
  out: string;
  err: string;
}

class Lab {
  readonly startedAt = Date.now() / 1000;
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-reap-' }));
  readonly state = join(this.dir, 'state');
  readonly project = join(this.dir, 'proj');
  readonly chat: SubagentChat;
  readonly svc: SubagentWorktrees;
  readonly server: ArtifactMcpHttp;
  readonly file: string;
  readonly reaped: { rec: string; killed: number }[] = [];
  readonly children: Deno.ChildProcess[] = [];
  readonly cleanup: [string, string][] = [];
  key = '';
  binary = '';

  constructor(provider: 'claude' | 'codex') {
    Deno.mkdirSync(this.state, { recursive: true });
    Deno.mkdirSync(this.project, { recursive: true });
    git(this.project, 'init', '-q', '-b', 'main');
    Deno.writeTextFileSync(join(this.project, 'tracked.txt'), 'one\n');
    git(this.project, 'add', '-A');
    git(this.project, 'commit', '-q', '-m', 'first');
    this.chat = {
      id: CHAT,
      provider,
      lasting: `${provider}:s1`,
      folder: this.project,
      project: this.project,
      hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false, shellTag: true },
    };
    this.svc = new SubagentWorktrees(this.state, join(this.state, 'worktrees'), (id) => (id === CHAT ? this.chat : null));
    this.svc.reaper = new ProcessReaper();
    this.svc.reapDelayMs = 200;
    this.svc.onReaped = (_chat, rec, killed) => this.reaped.push({ rec: rec?.id ?? '', killed });
    this.file = join(this.state, 'artifact-mcp.json');
    configure(this.state);
    this.key = issueHookKey(CHAT)!;
    this.server = new ArtifactMcpHttp({
      conversation: () => null,
      baseUrl: () => '',
      urlFile: '',
      addressFile: this.file,
      hook: (event, conversation, body) =>
        event.startsWith('codex-') ? codexHook(this.svc, event, this.chat, body as Json) : this.svc.hook(event, conversation, body),
    });
  }

  async start(): Promise<this> {
    this.binary = await keeperBinary();
    this.server.start();
    return this;
  }

  /** A running subagent's record (what its Agent call and start would have made); `path`: its worktree (Codex's cd). */
  seed(id: string, agentId: string, path = ''): void {
    const rec = {
      id, kind: 'subagent', chat: CHAT, lasting: this.chat.lasting, project: this.project, folder: this.project, slug: id, branch: '',
      path, snapshot: '', tree: '', state: 'running', toolUseId: `tu_${id}`, agentId, agentType: 'general-purpose', description: 'Builder',
      createdAt: Date.now() / 1000 - 2, boundAt: Date.now() / 1000 - 1,
    };
    const file = join(this.state, FILE);
    let all: Json = {};
    try {
      all = (JSON.parse(Deno.readTextFileSync(file)) as { subagents: Json }).subagents;
    } catch { /* first record */ }
    all[id] = rec;
    Deno.writeTextFileSync(file, JSON.stringify({ version: 1, subagents: all }));
    this.cleanup.push([CHAT, agentId]);
  }

  /** The forwarder program, as the agent's hook runs it. */
  async forward(event: string, payload: Json): Promise<Run> {
    const child = new Deno.Command(this.binary, {
      args: ['hook', event, this.file],
      env: { AIB_HOOK_KEY: this.key, AIB_HOOK_CHAT: CHAT, AIB_HOOK_READONLY: 'Explore' },
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
    await writer.close();
    const out = await child.output();
    return { code: out.code, out: DEC.decode(out.stdout), err: DEC.decode(out.stderr) };
  }

  /** A subagent's shell call through the forwarder: the command AIB rewrote it to. */
  async tag(agent: string, call: string, command: string): Promise<string> {
    const run = await this.forward('pre-shell', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: call,
      agent_id: agent,
      agent_type: 'general-purpose',
      tool_input: { command },
    });
    assertEquals([run.code, run.err], [0, '']);
    return JSON.parse(run.out).hookSpecificOutput.updatedInput.command;
  }

  /** Runs a command in Git Bash without waiting (stdio closed: it may outlive its shell). */
  spawn(command: string, env: Record<string, string> = {}): Deno.ChildProcess {
    const child = new Deno.Command(BASH, { args: ['-c', command], env, stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
    this.children.push(child);
    return child;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const child of this.children) {
      try {
        if (WIN) new Deno.Command('taskkill', { args: ['/T', '/F', '/PID', String(child.pid)], stdout: 'null', stderr: 'null' }).outputSync();
        else child.kill('SIGKILL');
      } catch { /* gone */ }
    }
    const reaper = new ProcessReaper();
    for (const [chat, owner] of [...this.cleanup, [OTHER_CHAT, 'agent7'], [CHAT, 'main'], [CHAT, 'agent8']]) {
      await reaper.reap({ chat, owner, since: Date.now() / 1000 - 600 }).catch(() => {});
    }
    await sweepLeftovers(this.startedAt);
    await this.server.close().catch(() => {});
    configure(null);
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await sleep(200);
      }
    }
  }
}

/** A detached background process with a child under it: the shell that started it is gone at once (an orphan). */
const DETACHED = `(bash -c "${PAIR}" >/dev/null 2>&1 &)`;

Deno.test({
  name: 'a subagent finishes: its tagged background process and its child are shut down; look-alikes, others and the main chat are not',
  ...T,
  async fn() {
    await using lab = await new Lab('claude').start();
    lab.seed('sa_one', 'agent7');
    lab.seed('sa_two', 'agent8');
    const call = 'toolu_bg1';
    lab.spawn(await lab.tag('agent7', call, DETACHED));
    // another subagent of the same chat, running: not touched
    lab.spawn(await lab.tag('agent8', 'toolu_other', DETACHED));
    // look-alikes without the exact cookie: untagged, the main chat's, another chat's, a cookie of the wrong shape
    const untagged = lab.spawn(`bash -c "${PAIR}"`);
    const main = lab.spawn(`bash -c "${PAIR}"`, { AIB_PROC: `${CHAT}.main.toolu_m1` });
    const foreign = lab.spawn(`bash -c "${PAIR}"`, { AIB_PROC: `${OTHER_CHAT}.agent7.${call}` });
    const odd = lab.spawn(`bash -c "${PAIR}"`, { AIB_PROC: `${CHAT}.agent7.${call}.extra` });
    await until('the tagged processes are up', () => carrying(CHAT, 'agent7').length >= 2 && carrying(CHAT, 'agent8').length >= 2);
    await until('the look-alikes are up', () => [untagged, main, foreign, odd].every((c) => !!realProcesses.list(0)?.some((p) => p.pid === c.pid)));
    const mine = carrying(CHAT, 'agent7');
    assert(mine.length >= 2, `a process and its child carry the cookie (${mine.length})`);
    const kept = [...carrying(CHAT, 'agent8'), ...carrying(CHAT, 'main'), ...carrying(OTHER_CHAT, 'agent7')];

    // the subagent finishes (the real forwarder's SubagentStop)
    const stop = await lab.forward('subagent-stop', { agent_id: 'agent7', agent_type: 'general-purpose' });
    assertEquals(stop.code, 0, stop.err);
    await until('its processes are gone', () => carrying(CHAT, 'agent7').length === 0);
    for (const p of mine) assert(!alive(p.pid, p.started), `process ${p.pid} was shut down`);
    await until('the parent is told', () => lab.reaped.length === 1);
    assert(lab.reaped[0].killed >= 2, `counts what it shut down (${lab.reaped[0].killed})`);
    assertEquals(lab.reaped[0].rec, 'sa_one');
    assertEquals(reapedWhyIn(lab.state)(call), 'subagent finished', 'its row reads stopped: subagent finished');
    assertEquals(reapedWhyIn(lab.state)('toolu_other'), '');

    // everything else is still running
    for (const p of kept) assert(alive(p.pid, p.started), `process ${p.pid} of ${p.cookie} was left alone`);
    for (const c of [untagged, main, foreign, odd]) assert(!!realProcesses.list(0)?.some((p) => p.pid === c.pid), 'a look-alike was left alone');
    assertEquals(carrying(CHAT, 'agent8').length >= 2, true, 'the other subagent still runs');
  },
});

Deno.test({
  name: 'TaskStop of one background call shuts down only that call; the other call runs until the subagent finishes',
  ...T,
  async fn() {
    await using lab = await new Lab('claude').start();
    lab.seed('sa_one', 'agent7');
    lab.spawn(await lab.tag('agent7', 'toolu_a', DETACHED));
    lab.spawn(await lab.tag('agent7', 'toolu_b', DETACHED));
    await until('both calls run', () => carrying(CHAT, 'agent7', 'toolu_a').length >= 2 && carrying(CHAT, 'agent7', 'toolu_b').length >= 2);
    const b = carrying(CHAT, 'agent7', 'toolu_b');
    // the main agent stops the task of call a (its task id maps to the call; the id of the call itself works too)
    lab.svc.noteTask(CHAT, 'task_a', 'toolu_a');
    await lab.svc.claudeTool(CHAT, 'TaskStop', 'toolu_stop1', { task_id: 'task_a' }, 'completed');
    await until('call a is gone', () => carrying(CHAT, 'agent7', 'toolu_a').length === 0);
    await until('the row is marked', () => reapedWhyIn(lab.state)('toolu_a') !== '');
    assertEquals(reapedWhyIn(lab.state)('toolu_a'), 'its task was stopped');
    assertEquals(reapedWhyIn(lab.state)('toolu_b'), '');
    for (const p of b) assert(alive(p.pid, p.started), 'call b was left alone');
    assertEquals(lab.svc.ofChat(CHAT)[0].state, 'running', 'the subagent itself still runs');
    // a call id never tagged by AIB, and another chat's call id: nothing happens
    await lab.svc.claudeTool(CHAT, 'TaskStop', 'toolu_stop2', { task_id: 'toolu_unknown' }, 'completed');
    await sleep(800);
    for (const p of b) assert(alive(p.pid, p.started), 'an unknown task id kills nothing');
    // the subagent finishes: call b goes now
    await lab.forward('subagent-stop', { agent_id: 'agent7', agent_type: 'general-purpose' });
    await until('call b is gone', () => carrying(CHAT, 'agent7').length === 0);
  },
});

Deno.test({
  name: 'a process that started before its call is not killed (a session reused across calls), the call\'s own processes are',
  ...T,
  async fn() {
    await using lab = await new Lab('claude').start();
    lab.seed('sa_one', 'agent7');
    // carries the cookie of call toolu_old, but started long before AIB tagged that call
    lab.spawn(`bash -c "${PAIR}"`, { AIB_PROC: `${CHAT}.agent7.toolu_old` });
    await until('it runs', () => carrying(CHAT, 'agent7', 'toolu_old').length >= 1);
    const old = carrying(CHAT, 'agent7', 'toolu_old');
    await sleep(3600); // past the start time slack
    lab.spawn(await lab.tag('agent7', 'toolu_old', DETACHED)); // the call is tagged now, later than that process
    lab.spawn(await lab.tag('agent7', 'toolu_new', DETACHED));
    await until('the new call runs', () => carrying(CHAT, 'agent7', 'toolu_new').length >= 2);
    await lab.forward('subagent-stop', { agent_id: 'agent7', agent_type: 'general-purpose' });
    await until('the new call is gone', () => carrying(CHAT, 'agent7', 'toolu_new').length === 0);
    for (const p of old) assert(alive(p.pid, p.started), `process ${p.pid}, older than its call, was left alone`);
  },
});

Deno.test('the checks before the kill: a reused pid, a changed cookie and a process older than the subagent are not killed', async () => {
  const cookie = `${CHAT}.agent7.toolu_1`;
  const T0 = Date.now() / 1000 - 100;
  let scans = 0;
  let cookieCalls = 0;
  const killed: number[] = [];
  const source = (second: Seen[], cookies2?: Map<number, string>): ProcSource => ({
    list: (since) => {
      scans++;
      // the scan: pid 10 (tagged), 11 (its child), 12 (older than the subagent); the re-check: `second`
      return scans === 1 ? [{ pid: 10, parentPid: 1, started: T0 + 5 }, { pid: 11, parentPid: 10, started: T0 + 6 }, { pid: 12, parentPid: 1, started: T0 - 50 }]
        .filter((p) => p.started >= since) : second;
    },
    cookies: (pids) => ++cookieCalls <= 1 ? new Map(pids.map((p) => [p, cookie])) : (cookies2 ?? new Map(pids.map((p) => [p, cookie]))),
  });
  const kill = (targets: { pid: number }[]) => {
    killed.push(...targets.map((t) => t.pid));
    return Promise.resolve(targets.map((t) => ({ pid: t.pid, started: 0 })));
  };
  const req = { chat: CHAT, owner: 'agent7', since: T0 };
  // control: nothing changed, the tagged process and its child go (pid 12 is older than the subagent: never)
  let r = await new ProcessReaper(source([{ pid: 10, parentPid: 1, started: T0 + 5 }, { pid: 11, parentPid: 10, started: T0 + 6 }]), kill as never, 1, 0)
    .reap(req);
  assertEquals([...new Set(killed)].sort(), [10, 11]);
  assertEquals(r.killed, 2);
  // the pid was reused between the scan and the kill: another process (a later start time) has it now
  scans = 0;
  cookieCalls = 0;
  killed.length = 0;
  r = await new ProcessReaper(source([{ pid: 10, parentPid: 1, started: T0 + 60 }]), kill as never, 1, 0).reap(req);
  assertEquals(killed, []);
  assertEquals(r.killed, 0);
  // the cookie is not the same any more at the re-check
  scans = 0;
  cookieCalls = 0;
  r = await new ProcessReaper(source([{ pid: 10, parentPid: 1, started: T0 + 5 }], new Map([[10, `${CHAT}.agent8.toolu_1`]])), kill as never, 1, 0)
    .reap(req);
  assertEquals(killed, []);
  // a request for nobody (no owner, no call) never kills
  scans = 0;
  cookieCalls = 0;
  r = await new ProcessReaper(source([]), kill as never, 1, 0).reap({ chat: CHAT, since: T0 });
  assertEquals([killed, r.killed], [[], 0]);
});

Deno.test({
  name: 'Codex: a subagent finishes (codex-subagent-stop): its tagged background process and its child are shut down, the main thread\'s are not',
  ...T,
  async fn() {
    await using lab = await new Lab('codex').start();
    // the real start: the main thread's spawn_agent, then the subagent's start (its worktree)
    assertEquals((await lab.forward('codex-pre-tool', { tool_name: 'spawn_agent', tool_use_id: 'call_0', tool_input: { message: 'do it' } })).code, 0);
    assertEquals((await lab.forward('codex-subagent-start', { agent_id: 'agent-1', agent_type: 'default' })).code, 0);
    lab.cleanup.push([CHAT, 'agent-1']);
    const answer = await lab.forward('codex-pre-tool', {
      tool_name: 'Bash',
      agent_id: 'agent-1',
      tool_use_id: 'call_9',
      tool_input: { command: WIN ? `& '${BASH}' -c '${PAIR}'` : `bash -c '${PAIR}'` },
    });
    assertEquals(answer.code, 0, answer.err);
    const command: string = JSON.parse(answer.out).hookSpecificOutput.updatedInput.command;
    assert(command.includes(`AIB_PROC='${CHAT}.agent-1.call_9'`), command);
    const shell = WIN
      ? new Deno.Command('powershell.exe', { args: ['-NoProfile', '-NonInteractive', '-Command', command], stdin: 'null', stdout: 'null', stderr: 'null' }).spawn()
      : lab.spawn(command);
    if (WIN) lab.children.push(shell);
    const main = lab.spawn(`bash -c "${PAIR}"`, { AIB_PROC: `${CHAT}.main.call_1` });
    await until('the tagged processes are up', () => carrying(CHAT, 'agent-1').length >= 2);
    const mine = carrying(CHAT, 'agent-1');
    const stop = await lab.forward('codex-subagent-stop', { agent_id: 'agent-1', agent_type: 'default' });
    assertEquals(stop.code, 0, stop.err);
    await until('its processes are gone', () => carrying(CHAT, 'agent-1').length === 0);
    for (const p of mine) assert(!alive(p.pid, p.started), `process ${p.pid} was shut down`);
    assert(!!realProcesses.list(0)?.some((p) => p.pid === main.pid), "the main thread's process was left alone");
    await until('the row is marked', () => reapedWhyIn(lab.state)('call_9') !== '');
    assert(reapedWhyIn(lab.state)('call_9').startsWith('it was still running'));
    await until('the parent is told', () => lab.reaped.length === 1);
  },
});

Deno.test({
  name: 'the Activity rows of calls AIB shut down read "stopped: subagent finished"; the others keep their state',
  ...T,
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-reaprows-' });
    try {
      const claude = join(dir, 'claude');
      fx.processFixtures(claude);
      const source = await m.Catalog.open(join(dir, 'omp'), claude);
      const get = async (options: m.HandlerOptions) =>
        (await m.handleGet(source, '/api/commands', `session=${encodeURIComponent('claude/monitorRunning/sess.jsonl')}`, options)).body as Json;
      assertEquals((await get({})).running, 1, 'the fixture has a running command');
      const stopped = await get({ stoppedCall: () => 'subagent finished' });
      assertEquals(stopped.running, 0);
      const rows = stopped.commands as Json[];
      assert(rows.length && rows.every((t) => t.status === 'killed' && t.stoppedReason === 'subagent finished'), JSON.stringify(rows));
      assertEquals((await get({ stoppedCall: () => '' })).running, 1, 'a call AIB did not shut down is untouched');
      // the file behind reapedWhyIn
      const state = join(dir, 'state');
      Deno.mkdirSync(state);
      recordReaped(state, ['toolu_x'], 'subagent finished');
      assertEquals([reapedWhyIn(state)('toolu_x'), reapedWhyIn(state)('toolu_y')], ['subagent finished', '']);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test('Windows Git Bash: the cookie is also read from the PATH marker (MSYS processes keep only PATH); ambiguous ones read as untagged', () => {
  const cookie = cookieOf(CHAT, 'agent7', 'toolu_1')!;
  const path = `PATH=C:\\Windows;C:\\Program Files\\Git\\aibproc\\${cookie}`;
  assertEquals(cookieIn([path, 'SYSTEMROOT=C:\\Windows'], true), cookie);
  assertEquals(cookieIn([`AIB_PROC=${cookie}`], true), cookie, 'a native process holds the variable itself');
  assertEquals(cookieIn([`aib_proc=${cookie}`, path], true), cookie, 'both, the same: fine (names are not case sensitive on Windows)');
  assertEquals(cookieIn([`AIB_PROC=${CHAT}.agent8.toolu_2`, path], true), null, 'they differ: never a guess');
  assertEquals(cookieIn([`PATH=C:\\a;C:\\b\\aibproc\\${CHAT}.agent7.toolu_0;C:\\c\\aibproc\\${cookie}`], true), cookie, 'the last entry wins');
  assertEquals(cookieIn(['PATH=C:\\x\\aibproc\\notacookie;C:\\y'], true), null);
  assertEquals(cookieIn([path], false), null, 'elsewhere only the variable counts');
  // the prefix: the bash form on Windows carries the marker, elsewhere it does not; every reader takes either off
  assertEquals(tagPrefix('bash', cookie, 'linux'), `export AIB_PROC='${cookie}'; `);
  assertEquals(tagPrefix('bash', cookie, 'windows'), `export AIB_PROC='${cookie}'; export PATH="$PATH:/aibproc/${cookie}"; `);
  assertEquals(tagPrefix('pwsh', cookie, 'windows'), `$env:AIB_PROC='${cookie}'; `);
  for (const os of ['linux', 'windows']) {
    assertEquals(stripAibPrefix(`${tagPrefix('bash', cookie, os)}npm test`, CHAT), 'npm test', os);
    assertEquals(stripAibPrefixes(`bash -c "${tagPrefix('bash', cookie, os)}npm test"`, CHAT), 'bash -c "npm test"', os);
  }
  // another cookie's marker is not the prefix's
  const other = `export AIB_PROC='${cookie}'; export PATH="$PATH:/aibproc/${CHAT}.agent7.toolu_9"; npm test`;
  assertEquals(stripAibPrefix(other, CHAT), `export PATH="$PATH:/aibproc/${CHAT}.agent7.toolu_9"; npm test`);
});

/**
 * The real distro: the Linux keeper's hook tags the subagent's shell call (Claude: `hook pre-shell`; Codex: the cookie in its
 * `codex-pre-tool` answer), the helper's reaper (the same service and reaper, natively over the distro's /proc) shuts the process down
 * after the subagent ends, and AIB posts the line.
 */
async function wslReap(provider: 'claude' | 'codex') {
  {
    const e = await import('./_wsl_e2e.ts');
    if (!e.WSL_E2E) {
      console.log('(no WSL 2 distro named by AIB_WSL_E2E here: nothing to check)');
      return;
    }
    const { Connection } = await import('../../app/server/acp/connection.ts');
    const { Aib } = await import('../../app/server/host/aib.ts');
    const { refOf } = await import('../../app/server/platform/location.ts');
    const { inDistro, ROOT, KEY } = e;
    const sh = async (script: string, ...args: string[]) => (await inDistro(script, args)).out.trim();
    await e.prepareRoot();
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-reap-e2e-' });
    Deno.env.set('AGENT_STUDIO_ALLOW_REAL_AGENT', '1'); // hooks are set up for a non-fixture agent (the factory below runs the fake agent)
    const aib = new Aib({ stateDir: state, port: 0, ownersDir: null }, { keeper: null });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(['node', `${ROOT}/fake_acp.mjs`, '--cancel-aware'], cwd, provider, {
        ...options,
        wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/node' } : options?.wsl,
      });
    const started: string[] = []; // the pids this test started in the distro (the only ones it ever signals)
    /**
     * ONE long-lived wsl.exe session that starts the test's processes: a process started in a wsl.exe call that has ended does not
     * outlive it (checked), so the processes live in this session, as a subagent's live in its agent's. Each command runs in a subshell.
     */
    const SYS = Deno.env.get('SystemRoot') ?? 'C:\\Windows';
    const child = new Deno.Command(`${SYS}\\System32\\wsl.exe`, {
      args: ['--distribution', e.DISTRO, '--cd', '~', '--exec', 'sh', '-c', 'while IFS= read -r l; do ( eval "$l" ); echo "@@done"; done'],
      env: { SystemRoot: SYS, WSL_UTF8: '1', WSLENV: '' },
      clearEnv: true,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    const writer = child.stdin.getWriter();
    const reader = child.stdout.getReader();
    let pending = '';
    const session = {
      async run(line: string, limitMs = 20_000): Promise<string> {
        await writer.write(new TextEncoder().encode(line.replaceAll('\n', ' ') + '\n'));
        const end = Date.now() + limitMs;
        while (!pending.includes('@@done\n')) {
          if (Date.now() > end) throw new Error(`the distro session gave no answer to: ${line.slice(0, 80)}`);
          const got = await Promise.race([reader.read(), sleep(1000).then(() => null)]);
          if (got && !got.done) pending += new TextDecoder().decode(got.value);
          else if (got?.done) throw new Error('the distro session ended');
        }
        const at = pending.indexOf('@@done\n');
        const out = pending.slice(0, at).replaceAll('\r', '').trim();
        pending = pending.slice(at + 7);
        return out;
      },
      async close(): Promise<void> {
        try {
          await writer.close();
        } catch { /* gone */ }
        try {
          await Promise.race([child.status, sleep(10_000)]);
        } catch { /* gone */ }
      },
    };
    const A = NUM, B = NUM + 1, C = NUM + 2;
    try {
      const repo = `${ROOT}/repo`;
      await sh('git -C "$1" branch -M main', repo);
      const host = await e.readyHost();
      if (!host.hookShellTag) {
        console.log("(the distro's AIB helper predates shell tagging: nothing to check)");
        return;
      }
      if (provider === 'codex') {
        // a Codex-shaped subagent: spawn_agent from the main thread, SubagentStart, Bash calls with the subagent's agent_id (the codex-pre-tool
        // answer carries the cookie, bash form), SubagentStop
        const cx = await aib.connect('codex', refOf({ kind: 'wsl', distro: KEY, linuxPath: repo }));
        for (let i = 0; i < 100 && cx.busy; i++) await sleep(100);
        assertEquals(cx.subagentHooks!.off, '', JSON.stringify(cx.subagentHooks));
        assertEquals(cx.subagentHooks!.shellTag, true, "a WSL Codex chat on a helper of this build tags its subagents' shell calls");
        const cxEnv = (cx as unknown as { env: Record<string, string> }).env;
        const cfg = JSON.parse(cxEnv.CODEX_CONFIG) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
        const cmdOf = (event: string) => cfg.hooks[event].at(-1)!.hooks[0].command;
        const runCx = (command: string, input: unknown) =>
          inDistro(
            'export AIB_HOOK_KEY="$1" AIB_HOOK_CHAT="$2"; exec sh -c "$3"',
            [cxEnv.AIB_HOOK_KEY, cx.id, command],
            new TextEncoder().encode(JSON.stringify(input)),
          );
        const seenCx: string[] = [];
        const recordCx = cx.recordedEvent.bind(cx);
        cx.recordedEvent = (kind: string, data: unknown, time?: number) => {
          if (kind === 'studio_note') seenCx.push(String((data as Json).message));
          recordCx(kind, data, time);
        };
        const spawn = await runCx(cmdOf('PreToolUse'), { tool_name: 'spawn_agent', tool_use_id: 'call_1', tool_input: { message: 'run the dev server' } });
        assertEquals(spawn.code, 0, spawn.err);
        const start = await runCx(cmdOf('SubagentStart'), { agent_id: 'cx1', agent_type: 'default' });
        assertEquals(start.code, 0, start.err);
        const callBody = (call: string, agent: string | null, command: string) => ({ tool_name: 'Bash', tool_use_id: call, ...(agent ? { agent_id: agent } : {}), tool_input: { command } });
        const bg = (secs: number) => `setsid sleep ${secs} >/dev/null 2>&1 < /dev/null & echo $!`;
        // the main thread's own call is not tagged; the subagent's gets the cookie in front of AIB's cd
        const mainCall = await runCx(cmdOf('PreToolUse'), callBody('call_m', null, 'echo hi'));
        assertEquals(mainCall.code, 0, mainCall.err);
        assert(!mainCall.out.includes('AIB_PROC'), mainCall.out);
        const tagCx = async (call: string, agent: string, command: string) => {
          const a = await runCx(cmdOf('PreToolUse'), callBody(call, agent, command));
          assertEquals(a.code, 0, a.err);
          return JSON.parse(a.out).hookSpecificOutput.updatedInput.command as string;
        };
        const first = await tagCx('call_t1', 'cx1', bg(A));
        assert(first.startsWith(`export AIB_PROC='${cx.id}.cx1.call_t1'; cd '`) && first.endsWith(`; ${bg(A)}`), first);
        const second = await tagCx('call_t2', 'cx1', bg(B));
        const startOther = await runCx(cmdOf('SubagentStart'), { agent_id: 'cx2', agent_type: 'default' }); // another subagent (no spawn call: bound on its first call)
        assertEquals(startOther.code, 0, startOther.err);
        const other = `export AIB_PROC='${cx.id}.cx2.call_x'; ${bg(C)}`;
        const startedPid = async (command: string) => {
          const out = await session.run(command);
          const pid = out.split('\n').pop()!.trim();
          assert(/^\d+$/.test(pid), `not a pid: ${out}`);
          started.push(pid);
          return pid;
        };
        const pA = await startedPid(first), pB = await startedPid(second), pC = await startedPid(other);
        const up = async (pid: string) => (await session.run(`kill -0 ${Number(pid)} 2>/dev/null && echo up || echo down`)) === 'up';
        assert(await up(pA) && await up(pB) && await up(pC), 'the three processes are running');
        const stopped = await runCx(cmdOf('SubagentStop'), { agent_id: 'cx1', agent_type: 'default' });
        assertEquals(stopped.code, 0, stopped.err);
        await until("the Codex subagent's tagged processes are shut down in the distro", async () => !(await up(pA)) && !(await up(pB)), 60_000);
        assert(await up(pC), "another subagent's process is never touched");
        await until('the line in the parent chat', () => seenCx.some((m) => /finished; its processes were shut down \(2\)/.test(m)), 60_000);
        const whyCx = reapedWhyIn(state);
        assertEquals(whyCx('call_t1'), 'subagent finished');
        assertEquals(whyCx('call_t2'), 'subagent finished');
        assertEquals(whyCx('call_x'), '');
        return;
      }
      const c = await aib.connect('claude', refOf({ kind: 'wsl', distro: KEY, linuxPath: repo }));
      for (let i = 0; i < 100 && c.busy; i++) await sleep(100);
      assertEquals(c.subagentHooks!.off, '', JSON.stringify(c.subagentHooks));
      assertEquals(c.subagentHooks!.shellTag, true, 'a WSL chat on a helper of this build tags its subagents\' shell calls');
      const hooks = (c.subagentHooks!.settings as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks;
      const shellHook = hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)).find((cmd) => cmd.includes(' hook pre-shell '))!;
      assert(shellHook && shellHook.includes('--helper-socket') && !shellHook.includes('|| exit 2'), String(shellHook));
      const preTool = hooks.PreToolUse[0].hooks[0].command;
      const create = hooks.WorktreeCreate[0].hooks[0].command;
      const stopHook = hooks.SubagentStop[0].hooks[0].command;
      const env = (c as unknown as { env: Record<string, string> }).env;
      const run = (command: string, input: unknown) =>
        inDistro(
          'export AIB_HOOK_KEY="$1" AIB_HOOK_CHAT="$2" AIB_HOOK_READONLY="$3"; exec sh -c "$4"',
          [env.AIB_HOOK_KEY, c.id, env.AIB_HOOK_READONLY ?? '', command],
          new TextEncoder().encode(JSON.stringify(input)),
        );
      const seen: string[] = [];
      const record = c.recordedEvent.bind(c);
      c.recordedEvent = (kind: string, data: unknown, time?: number) => {
        if (kind === 'studio_note') seen.push(String((data as Json).message));
        record(kind, data, time);
      };

      // a subagent with its own worktree (the same path as wsl_subagents_e2e_test.ts)
      const pre = await run(preTool, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'general-purpose', description: 'Run the dev server', prompt: 'x' } });
      assertEquals(pre.code, 0, pre.err);
      const made = await run(create, { hook_event_name: 'WorktreeCreate', name: 'agent-a1' });
      assertEquals(made.code, 0, made.err);

      // the main agent's own shell call is never tagged
      const main = await run(shellHook, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_m', tool_input: { command: 'echo hi' } });
      assertEquals(main.code, 0, main.err);
      assertEquals(main.out.trim(), '');
      // the subagent's: the cookie goes in front of the command, nothing else changes
      const body = (call: string, agent: string, command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: call, agent_id: agent, tool_input: { command, description: 'd' } });
      const background = (secs: number) => `setsid sleep ${secs} >/dev/null 2>&1 < /dev/null & echo $!`;
      const tagged = await run(shellHook, body('toolu_sh1', 'a1', background(A)));
      assertEquals(tagged.code, 0, tagged.err);
      const updated = JSON.parse(tagged.out).hookSpecificOutput.updatedInput as { command: string; description: string };
      assertEquals(updated.command, `export AIB_PROC='${c.id}.a1.toolu_sh1'; ${background(A)}`);
      assertEquals(updated.description, 'd');
      // a second call of the subagent, another subagent's cookie and an untagged lookalike
      const second = JSON.parse((await run(shellHook, body('toolu_sh2', 'a1', `setsid sleep ${B} >/dev/null 2>&1 < /dev/null & echo $!`))).out).hookSpecificOutput.updatedInput.command;
      const otherAgent = `export AIB_PROC='${c.id}.a2.toolu_x'; ${background(C)}`;
      const pids = async (command: string) => {
        const out = await session.run(command);
        const pid = out.split('\n').pop()!.trim();
        assert(/^\d+$/.test(pid), `not a pid: ${out}`);
        started.push(pid);
        return pid;
      };
      const pidA = await pids(updated.command);
      const pidB = await pids(second);
      const pidC = await pids(otherAgent);
      const alive = async (pid: string) => (await session.run(`kill -0 ${Number(pid)} 2>/dev/null && echo up || echo down`)) === 'up';
      assert(await alive(pidA) && await alive(pidB) && await alive(pidC), 'the three processes are running');

      // the subagent ends: ITS two processes go within seconds; another subagent's cookie is left alone
      const stop = await run(stopHook, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose' });
      assertEquals(stop.code, 0, stop.err);
      await until('the subagent\'s tagged processes are shut down in the distro', async () => !(await alive(pidA)) && !(await alive(pidB)), 60_000);
      assert(await alive(pidC), "another subagent's process is never touched");
      // Windows learns of it through subagent.reaps: the parent chat's line, and the Activity rows' reason
      await until('the line in the parent chat', () => seen.some((m) => /finished; its processes were shut down \(2\)/.test(m)), 60_000);
      const why = reapedWhyIn(state);
      assertEquals(why('toolu_sh1'), 'subagent finished');
      assertEquals(why('toolu_sh2'), 'subagent finished');
      assertEquals(why('toolu_x'), '');
      assertEquals(seen.filter((m) => /its processes were shut down/.test(m)).length, 1, 'one line, posted once');

      // TaskStop of ONE background call of a WSL chat: the stream's task id (noteTask) is handed to the distro, which shuts down only that call
      const call4 = JSON.parse((await run(shellHook, body('toolu_sh4', 'a1', background(NUM + 3)))).out).hookSpecificOutput.updatedInput.command;
      const call5 = JSON.parse((await run(shellHook, body('toolu_sh5', 'a1', background(NUM + 4)))).out).hookSpecificOutput.updatedInput.command;
      const pid4 = await pids(call4);
      const pid5 = await pids(call5);
      c.onBackgroundTask?.(c, 'task-4', 'toolu_sh4');
      await sleep(500); // the distro learns the task id before the stop
      await aib.subagents!.claudeTool(c.id, 'TaskStop', 'toolu_stop4', { task_id: 'task-4' }, 'completed');
      await until("the stopped call's process is shut down in the distro", async () => !(await alive(pid4)), 60_000);
      assert(await alive(pid5), "the subagent's other call keeps running");
      await until('the line for the stopped call', () => seen.some((m) => /A stopped background command left processes running; they were shut down \(1\)/.test(m)), 60_000);
      assertEquals(reapedWhyIn(state)('toolu_sh4'), 'its task was stopped');
    } finally {
      for (const pid of started) await session.run(`kill ${Number(pid)} 2>/dev/null; true`).catch(() => {}); // only the pids this test started
      await session.close();
      await aib.close().catch(() => {});
      await e.cleanRoot();
      e.newAib();
      Deno.removeSync(state, { recursive: true });
    }
  }
}

Deno.test({
  name: 'WSL: a finished subagent of a WSL chat has its processes shut down inside the distro (needs AIB_WSL_E2E)',
  ignore: !Deno.env.get('AIB_WSL_E2E'),
  ...T,
  fn: () => wslReap('claude'),
});

Deno.test({
  name: 'WSL: a finished Codex subagent of a WSL chat has its processes shut down inside the distro (needs AIB_WSL_E2E)',
  ignore: !Deno.env.get('AIB_WSL_E2E'),
  ...T,
  fn: () => wslReap('codex'),
});
