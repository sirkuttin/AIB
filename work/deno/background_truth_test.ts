/**
 * One truth for "running in the background" (2026-11-24, "Ashborne orchestrator part3": the chat said Working, Activity said no
 * processes, and the tool rows were titled `toolu_...`). Real data: a subagent ended its turn while ~29 headless game runs it had started
 * still went on (AIB_PROC cookies on 38 live processes). Activity read its rows "Ended with the agent that started it" and showed it finished.
 *   - a subagent's row that read ended with its agent runs again while its process is alive (Activity lists it, the agent counts it),
 *     and stays ended when the process is gone, the check fails or none is given
 *   - the alive check costs one host call per chat per ttl, and a revived row whose process ends ends again
 *   - the subagents service tells alive and gone apart (cookie scan), a call it cannot tell about is neither
 *   - a subagent's background note names the command (title, input), never only `toolu_...`
 *   - the Activity pane: a finished subagent with live runs is "Waiting on N background runs", above the fold
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { type Json, SteerLab } from './_steer.ts';
import * as fx from './_monitor_fixtures.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import * as m from '../../app/server/transcripts/monitor.ts';
import { makeAliveCheck } from '../../app/server/transcripts/gone.ts';
import { ProcessReaper } from '../../app/server/subagents/reap.ts';
import { noteCall } from '../../app/server/subagents/shell_tag.ts';
import { SubagentWorktrees } from '../../app/server/subagents/service.ts';
import type { ProcSource, Seen } from '../../app/server/platform/proc_env.ts';

const T = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...T,
  name: "background truth: a finished subagent's command with a live process runs again; a dead one, a failing check and no check stay ended",
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-bgtruth-' });
    try {
      const claude = pathOf(dir, 'claude');
      fx.processFixtures(claude);
      const source = await m.Catalog.open(pathOf(dir, 'omp'), claude);
      const session = 'claude/finishedSidecar/sess.jsonl';
      const get = async (path: string, options: m.HandlerOptions) =>
        (await m.handleGet(source, path, `session=${encodeURIComponent(session)}`, options)).body as Json;
      const ended = await get('/api/commands', {});
      assertEquals(ended.running, 0);
      const rows = (ended.commands as Json[]).filter((t) => t.status === 'completed');
      assert(rows.length >= 1, 'the finished subagent has commands that read ended with it');
      assert(rows.every((t) => /Ended with the agent/.test(String(t.completionSummary))));
      const asked: string[] = [];
      const alive = (ids: Set<string>) => (_s: string, tasks: Json[]) => (asked.push(...tasks.map((t) => t.id as string)), Promise.resolve(ids));
      // alive: the rows run again, Activity lists them and the agent's count has them
      const all = new Set(rows.map((t) => t.id as string));
      const on = await get('/api/commands', { alive: alive(all) });
      assertEquals(on.running, rows.length);
      for (const t of on.commands as Json[]) if (all.has(t.id as string)) assertEquals(t.status, 'running');
      assert(asked.every((id) => all.has(id)), 'only rows that read ended with their agent are asked');
      const agents = (await get('/api/agents', { alive: alive(all) })).agents as Json[];
      assert(agents.some((a) => Number(a.runningCommands) === rows.length), JSON.stringify(agents.map((a) => a.runningCommands)));
      // one alive, one not: only that one runs
      const first = rows[0].id as string;
      const some = await get('/api/commands', { alive: alive(new Set([first])) });
      assertEquals(some.running, 1);
      // gone, failing and absent: every row stays ended
      for (const options of [{ alive: alive(new Set()) }, { alive: () => Promise.reject(new Error('host away')) }, {}] as m.HandlerOptions[]) {
        const same = await get('/api/commands', options);
        assertEquals(same.running, 0);
      }
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test('background truth: one batched host call per chat per ttl, and a revived row whose process ends ends again', async () => {
  let clock = 2_000_000;
  const asked: { call: string }[][] = [];
  let live = new Set(['c2']);
  const check = makeAliveCheck((_sid, calls) => {
    asked.push(calls);
    return Promise.resolve(calls.filter((c) => live.has(c.call)).map((c) => c.call));
  }, { ttlMs: 10_000, now: () => clock });
  const rows = [
    { id: 'sub#c2', callId: 'c2', agentKey: 'claude/p/s1/subagents/agent-x.jsonl' },
    { id: 'sub#c3', callId: 'c3', agentKey: 'claude/p/s1/subagents/agent-x.jsonl' },
    { id: 'sub#nocall', agentKey: 'claude/p/s1/subagents/agent-x.jsonl' },
  ];
  assertEquals([...await check('claude/p/s1.jsonl', rows)], ['sub#c2']);
  assertEquals(asked.length, 1);
  assertEquals(asked[0], [{ call: 'c2', main: false }, { call: 'c3', main: false }]);
  clock += 3000;
  assertEquals([...await check('claude/p/s1.jsonl', rows)], ['sub#c2']);
  assertEquals(asked.length, 1, 'inside the ttl nothing is asked again');
  live = new Set();
  clock += 8000;
  assertEquals([...await check('claude/p/s1.jsonl', rows)], [], 'its process ended: the row ends again');
  assertEquals(asked.length, 2);
  const failing = makeAliveCheck(() => Promise.reject(new Error('away')), { now: () => clock });
  assertEquals([...await failing('claude/p/s2.jsonl', rows)], []);
});

Deno.test({
  ...T,
  name: "background truth: the subagents service tells a live call from a gone one; a new or unknown call is neither",
  async fn() {
    const CHAT = 'c0ffee00aa11bb22cc33dd44ee55ff66';
    const nowS = Date.now() / 1000;
    const procs: (Seen & { cookie?: string })[] = [
      { pid: 100, parentPid: 1, started: nowS - 60, cookie: `${CHAT}.agent1.call_alive` },
      { pid: 101, parentPid: 100, started: nowS - 59 },
    ];
    const source: ProcSource = {
      list: () => procs.map(({ pid, parentPid, started }) => ({ pid, parentPid, started })),
      cookies: (pids) => new Map(procs.filter((p) => p.cookie && pids.includes(p.pid)).map((p) => [p.pid, p.cookie!])),
    };
    const dir = Deno.makeTempDirSync({ prefix: 'aib-bgtruth-svc-' });
    try {
      const chat = {
        id: CHAT,
        provider: 'claude',
        lasting: 'claude:s1',
        folder: dir,
        project: dir,
        hooks: { readOnly: new Set<string>(), userWorktreeHook: false, shellTag: true },
      };
      const svc = new SubagentWorktrees(pathOf(dir, 'state'), pathOf(dir, 'state', 'worktrees'), (id) => (id === CHAT ? chat : null));
      svc.reaper = new ProcessReaper(source);
      noteCall(CHAT, 'call_alive', nowS - 60);
      noteCall(CHAT, 'call_dead', nowS - 60);
      noteCall(CHAT, 'call_new', nowS - 1);
      const status = await svc.callsStatus(CHAT, ['call_alive', 'call_dead', 'call_new', 'call_unknown']);
      assertEquals(status, { gone: ['call_dead'], alive: ['call_alive'] });
      procs.splice(0, procs.length);
      const later = await svc.callsStatus(CHAT, ['call_alive', 'call_dead', 'call_new', 'call_unknown']);
      assertEquals([later.gone.sort(), later.alive], [['call_alive', 'call_dead'], []]);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "background truth: a subagent's background note names the command, never only the toolu_ id",
  ...T,
  async fn() {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('claude');
    await c.prompt('wait for the runs', 'm1');
    await p.take('session/prompt');
    const id = 'toolu_01JH7AqLZQ828vxQHMNpseQa';
    const command = 'until grep -q "all done" wave3.out; do sleep 20; done; echo finished';
    await p.update({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: command,
      kind: 'execute',
      status: 'pending',
      rawInput: { command, description: 'Wait until the third wave of mortal runs finishes', run_in_background: true },
      _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'toolu_0158sXY3CeVC7cNHVUG7Pnhk' } },
    });
    await until(() => c.events.some((e) => e.kind === 'update' && ((e.data as Json).update as Json).toolCallId === id), 'the tool call');
    await p.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'completed',
      rawOutput: 'Command running in background with ID: b3e1p76el. Output is being written to: /tmp/x.output.',
      _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'toolu_0158sXY3CeVC7cNHVUG7Pnhk', toolResponse: { backgroundTaskId: 'b3e1p76el' } } },
    });
    await until(() => (c.public().toolBackground as Json)[id] !== undefined, 'marked running in the background');
    const notes = c.events.map((e) => (e.data as Json).update as Json | undefined).filter((u) => u && u.background);
    assert(notes.length >= 1);
    for (const u of notes) {
      assertEquals(u!.title, command);
      assertEquals((u!.rawInput as Json).description, 'Wait until the third wave of mortal runs finishes');
      assertEquals(u!.kind, 'execute');
    }
  },
});

Deno.test('background truth: Activity shows a finished subagent with live runs as waiting, above the finished fold', async () => {
  const src = Deno.readTextFileSync(new URL('../../app/page/subagents-ui.js', import.meta.url));
  assert(/Waiting on ' \+ runs \+ ' background run'/.test(src), 'classify names the runs it waits on');
  assert(/group: 'working', kind: 'waiting-runs'/.test(src));
  const css = Deno.readTextFileSync(new URL('../../app/page/activity.css', import.meta.url));
  assert(/\.sa-waiting-runs \.sa-dot/.test(css));
});

Deno.test({
  name: "background truth: an idle chat whose finished subagent still has runs going reads shells and a working phase, and idle again when they end",
  ...T,
  async fn() {
    await using lab = new SteerLab();
    const { c } = await lab.chat('claude');
    assertEquals([c.attention().shells, c.attention().phase], [false, 'idle']);
    let runs = 29;
    c.ownRuns = () => runs;
    const a = c.attention();
    assertEquals([a.shells, a.phase, a.state], [true, 'working', 'idle']);
    runs = 0;
    assertEquals(c.attention().shells, false);
  },
});
