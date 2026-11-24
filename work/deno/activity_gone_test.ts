/**
 * Activity's "Processes" no longer trusts the agent's report alone (server/transcripts/gone.ts, monitor.ts withGone, host/aib.ts
 * backgroundGone, subagents/service.ts callsGone, subagents/reap.ts live): a background command whose process the owner or the lead
 * killed from outside turns "Ended (process gone)" within about 15 s; a running one stays running. Fake agents (fake_acp.mjs starts a real
 * child process as the shell), headless, temp folders.
 *   - the list (monitor handleGet over a fixture transcript): gone rows are ended (status, text, counts), the rest untouched; a failing
 *     or silent check leaves every row alone
 *   - the check's cost: one batched host call per chat per ttl, only for running rows, a gone row stays gone
 *   - the main agent's command: a real shell process killed from outside is reported gone, a running one is not
 *   - a subagent's command (AIB_PROC cookie scan): no process left = gone, a live one is not, a call too new or unknown is never judged
 */
import { assert, assertEquals } from './_assert.ts';
import { type Json, Lab, until } from './_connection.ts';
import * as fx from './_monitor_fixtures.ts';
import { AgentHost } from '../../app/server/host/agent_host.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import * as m from '../../app/server/transcripts/monitor.ts';
import { makeGoneCheck, sessionIdOf } from '../../app/server/transcripts/gone.ts';
import { ProcessReaper } from '../../app/server/subagents/reap.ts';
import { noteCall } from '../../app/server/subagents/shell_tag.ts';
import { SubagentWorktrees } from '../../app/server/subagents/service.ts';
import type { ProcSource, Seen } from '../../app/server/platform/proc_env.ts';

const T = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...T,
  name: 'activity gone: a row whose process is gone reads ended and stops counting; others, a silent and a failing check keep their state',
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-gonerows-' });
    try {
      const claude = pathOf(dir, 'claude');
      fx.processFixtures(claude);
      const source = await m.Catalog.open(pathOf(dir, 'omp'), claude);
      const session = 'claude/monitorRunning/sess.jsonl';
      const get = async (path: string, options: m.HandlerOptions, extra = '') =>
        (await m.handleGet(source, path, `session=${encodeURIComponent(session)}${extra}`, options)).body as Json;
      const plain = await get('/api/commands', {});
      assertEquals(plain.running, 1);
      const row = (plain.commands as Json[]).find((t) => t.status === 'running')!;
      const seen: string[] = [];
      // gone: ended, with a short reason, like any other ended row
      const ended = await get('/api/commands', {
        gone: (_s, rows) => (seen.push(...rows.map((t) => t.id as string)), Promise.resolve(new Set([row.id as string]))),
      });
      assertEquals(ended.running, 0);
      const got = (ended.commands as Json[]).find((t) => t.id === row.id)!;
      assertEquals([got.status, got.completionSummary], ['completed', 'Ended (process gone).']);
      assert(seen.length === 1 && seen[0] === row.id, `only the running rows are asked: ${seen}`);
      // the single-command route and the agents' counts agree
      const one = await get(
        '/api/command',
        { gone: () => Promise.resolve(new Set([row.id as string])) },
        `&id=${encodeURIComponent(row.id as string)}`,
      );
      assertEquals(one.status, 'completed');
      const agents = (await get('/api/agents', { gone: () => Promise.resolve(new Set([row.id as string])) })).agents as Json[];
      assert(agents.every((a) => !a.runningCommands), JSON.stringify(agents.map((a) => a.runningCommands)));
      // still alive (the check names nothing), a check that throws, and none: the row stays running
      for (const gone of [() => Promise.resolve(new Set<string>()), () => Promise.reject(new Error('host away')), undefined]) {
        const same = await get('/api/commands', gone ? { gone } : {});
        assertEquals(same.running, 1);
        assertEquals((same.commands as Json[]).find((t) => t.id === row.id)!.status, 'running');
      }
      // a saved-transcript key gives the host the session id
      assertEquals(sessionIdOf('claude/some-folder/0a1b2c3d.jsonl'), '0a1b2c3d');
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test('activity gone: one batched host call per chat per ttl, only running rows with a call id, and a gone row stays gone', async () => {
  let clock = 1_000_000;
  const asked: { sessionId: string; calls: { call: string; main: boolean }[] }[] = [];
  let dead = new Set<string>();
  const check = makeGoneCheck((sessionId, calls) => {
    asked.push({ sessionId, calls });
    return Promise.resolve(calls.filter((c) => dead.has(c.call)).map((c) => c.call));
  }, { ttlMs: 10_000, now: () => clock });
  const rows = [
    { id: 'main#c1', callId: 'c1', agentKey: 'claude/p/s1.jsonl', agent: 'Main conversation' },
    { id: 'sub#c2', callId: 'c2', agentKey: 'claude/p/s1/subagents/agent-x.jsonl', agent: 'general-purpose' },
    { id: 'main#nocall', agentKey: 'claude/p/s1.jsonl' },
  ];
  assertEquals([...await check('claude/p/s1.jsonl', rows)], []);
  assertEquals(asked.length, 1);
  assertEquals(asked[0].sessionId, 's1');
  assertEquals(asked[0].calls, [{ call: 'c1', main: true }, { call: 'c2', main: false }]);
  dead = new Set(['c1']);
  clock += 4000; // the page polls again: no new host call inside the ttl, nothing new learnt
  assertEquals([...await check('claude/p/s1.jsonl', rows)], []);
  assertEquals(asked.length, 1);
  clock += 7000; // past the ttl: asked again, now c1 is gone
  assertEquals([...await check('claude/p/s1.jsonl', rows)], ['main#c1']);
  assertEquals(asked.length, 2);
  dead = new Set();
  clock += 11_000; // gone stays gone (and is not asked about again)
  assertEquals([...await check('claude/p/s1.jsonl', rows)], ['main#c1']);
  assertEquals(asked[2].calls.map((c) => c.call), ['c2']);
  // another chat has its own clock; a host that fails leaves the rows alone
  const failing = makeGoneCheck(() => Promise.reject(new Error('away')), { now: () => clock });
  assertEquals([...await failing('claude/p/s2.jsonl', rows)], []);
});

class ShellLab extends Lab {
  gate(): string {
    return this.path('gate');
  }
}

Deno.test({
  ...T,
  name: "activity gone: the main agent's background shell killed from outside is reported gone within 15 s; a running one is not",
  async fn() {
    await using lab = new ShellLab();
    const host = new AgentHost({ stateDir: lab.dir, port: 0 } as never, 30, 0, { exitUnattachedSeconds: 10 });
    try {
      const aib = host.aib;
      const pidFile = lab.path('child');
      const c = await lab.open(['--held-turn', '--child-pid-file', pidFile], { provider: 'claude' });
      aib.connections.set(c.id, c);
      await c.prompt(`bgshell:${lab.gate()}`, 'm1');
      await until(() => !c.busy && Deno.statSync(pidFile + '.shell').isFile, 'the reply ended', 60);
      const shellPid = Number(Deno.readTextFileSync(pidFile + '.shell'));
      assert(pidAlive(shellPid));
      const ask = () => aib.backgroundGone(c.sessionId!, [{ call: 'bash-1', main: true }, { call: 'not-a-call', main: true }]);
      assertEquals(await ask(), [], 'running: stays running');
      // killed from outside (not by AIB, not by the agent): the owner's or the lead's kill
      Deno.kill(shellPid, 'SIGKILL');
      const started = Date.now();
      await until(async () => (await ask()).length === 1, 'reported gone', 15);
      assertEquals(await ask(), ['bash-1']);
      assert(Date.now() - started < 15_000);
      // the host op the web server calls
      const [status, body] = await aib.liveCall('bg-gone', { sessionId: c.sessionId, calls: [{ call: 'bash-1', main: true }] });
      assertEquals([status, (body as { gone: string[] }).gone], [200, ['bash-1']]);
      // a chat the host does not have: nothing is judged
      assertEquals(await aib.backgroundGone('no-such-session', [{ call: 'bash-1', main: true }]), []);
    } finally {
      host.aib.connections.clear();
      await host.aib.close();
    }
  },
});

Deno.test({
  ...T,
  name:
    "activity gone: a subagent's command is gone when no process carries its cookie; a live one, a new call and an unknown one are not judged",
  async fn() {
    const CHAT = 'c0ffee00aa11bb22cc33dd44ee55ff66';
    const nowS = Date.now() / 1000;
    const procs: (Seen & { cookie?: string })[] = [
      { pid: 100, parentPid: 1, started: nowS - 60, cookie: `${CHAT}.agent1.call_alive` },
      { pid: 101, parentPid: 100, started: nowS - 59 }, // a child with no cookie of its own
      { pid: 102, parentPid: 1, started: nowS - 60, cookie: `othercht.agent1.call_dead` }, // another chat's: never this chat's
    ];
    let listable = true;
    const source: ProcSource = {
      list: () => (listable ? procs.map(({ pid, parentPid, started }) => ({ pid, parentPid, started })) : null),
      cookies: (pids) => new Map(procs.filter((p) => p.cookie && pids.includes(p.pid)).map((p) => [p.pid, p.cookie!])),
    };
    const reaper = new ProcessReaper(source);
    assertEquals([...reaper.live(CHAT, ['call_alive', 'call_dead'], nowS - 120)!], ['call_alive']);
    listable = false;
    assertEquals(reaper.live(CHAT, ['call_alive'], nowS - 120), null, 'processes that cannot be listed: nothing is judged');
    listable = true;

    const dir = Deno.makeTempDirSync({ prefix: 'aib-gonesub-' });
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
      svc.reaper = reaper;
      noteCall(CHAT, 'call_alive', nowS - 60);
      noteCall(CHAT, 'call_dead', nowS - 60);
      noteCall(CHAT, 'call_new', nowS - 1); // inside the grace: its process may not exist yet
      const ask = (calls: string[]) => svc.callsGone(CHAT, calls);
      assertEquals(await ask(['call_alive', 'call_dead', 'call_new', 'call_unknown']), ['call_dead']);
      // the process of call_alive dies (killed from outside): the next look finds it gone
      procs.splice(0, procs.length);
      assertEquals((await ask(['call_alive', 'call_dead', 'call_new', 'call_unknown'])).sort(), ['call_alive', 'call_dead']);
      listable = false;
      assertEquals(await ask(['call_alive']), [], 'no process list: nothing is judged');
      assertEquals(await svc.callsGone('another-chat', ['call_alive']), []);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
