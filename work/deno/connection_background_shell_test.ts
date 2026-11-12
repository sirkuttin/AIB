/**
 * server/acp/connection.ts backgroundShellsRunning + platform/descendants.ts: a Claude Code chat whose reply ended while a Bash
 * command it started with run_in_background still runs (a long test run). Claude Code tells AIB only that the command went to the
 * background (`_meta.claudeCode.toolResponse.backgroundTaskId` on the Bash result), never that it ended, so AIB notes the agent's
 * processes that started with the command and asks the OS whether they still run. fake_acp.py --held-turn 'bgshell:<gate>' replays
 * what claude-agent-acp 0.97.0 sent in a real run, with a real child process as the shell, which ends when the test creates <gate>.
 */
import { assert, assertEquals } from './_assert.ts';
import { events, type Json, Lab, until, updateTexts } from './_connection.ts';
import type { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { AgentHost } from '../../outputs/agent-studio/server/host/agent_host.ts';
import { descendants, elapsed, setTableReader } from '../../outputs/agent-studio/server/platform/descendants.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

const LONG = 60; // a deadline, not a delay

class ShellLab extends Lab {
  #gates = 0;
  gate(): string {
    return this.path(`gate-${this.#gates++}`);
  }
  open_(path: string): void {
    Deno.writeTextFileSync(path, 'go');
  }
}

const turnEnds = (c: Connection) => events(c, 'turn_end').map((e) => (e.data as Json).stopReason);

async function withHost(lab: ShellLab, fn: (host: AgentHost) => Promise<void>): Promise<void> {
  const host = new AgentHost({ ompCommand: 'unused', stateDir: lab.dir, port: 0 } as never, 30, 0, { exitUnattachedSeconds: 10 });
  try {
    await fn(host);
  } finally {
    host.studio.connections.clear();
    await host.studio.close();
  }
}

Deno.test("background shell: counts as 'background' while it runs (quit, update, idle exit), never as working; drops out when it ends", async () => {
  await using lab = new ShellLab();
  await withHost(lab, async (host) => {
    const studio = host.studio;
    // --child-pid-file: the agent also has a child from its start (as an MCP server is): it must not count as the shell.
    const pidFile = lab.path('child');
    const c = await lab.open(['--held-turn', '--child-pid-file', pidFile]);
    studio.connections.set(c.id, c);
    const gate = lab.gate();
    await c.prompt(`bgshell:${gate}`, 'm1');
    await until(() => !c.busy && turnEnds(c).length === 1, 'the reply ended', LONG);
    const shellPid = Number(Deno.readTextFileSync(pidFile + '.shell'));
    const oldChild = Number(Deno.readTextFileSync(pidFile));
    assert(pidAlive(shellPid) && pidAlive(oldChild));
    assertEquals(c.backgroundShells(), ['bfake1']);
    assertEquals(c.public().state, 'ready'); // not Working on the page
    assertEquals(c.attention().state, 'idle');
    assertEquals(c.promptReceipts.get('m1')?.state, 'finished');
    assertEquals(studio.busyList().map((b) => b.state), ['background']); // the quit decision and the updater count it
    assertEquals(studio.workingList().map((w) => w.state), ['background']);
    assertEquals(host.lifecycleCheck(5000), false);
    assertEquals(host.lifecycleCheck(5100), false, 'the host stays while the shell runs');
    assert(!(await c.queueAdd('next', 'q1')).queued, 'the queue does not wait for it');
    await until(() => updateTexts(c).includes('Fixture reply: next') && !c.busy, 'the queued reply', LONG);
    assertEquals(studio.busyList().map((b) => b.state), ['background']);

    lab.open_(gate); // the shell's command ends
    await until(() => !pidAlive(shellPid), 'the shell process ended', LONG);
    await until(() => studio.busyList().length === 0, 'the chat dropped out of the list', LONG);
    assertEquals(c.backgroundShells(), []);
    assert(pidAlive(oldChild), "the agent's older child still runs and does not count");
    await until(() => updateTexts(c).includes('The tests finished.') && !c.busy, "Claude Code's own cycle ended", LONG);
    assertEquals(studio.workingList(), []);
    assertEquals(host.lifecycleCheck(6000), false);
    assertEquals(host.lifecycleCheck(6011), true, 'nothing works any more: exits after the grace');
  });
});

Deno.test('background shell: when the processes cannot be listed, it counts until the task-notification cycle', async () => {
  await using lab = new ShellLab();
  setTableReader(() => null);
  try {
    await withHost(lab, async (host) => {
      const c = await lab.open(['--held-turn']);
      host.studio.connections.set(c.id, c);
      const gate = lab.gate();
      await c.prompt(`bgshell:${gate}`);
      await until(() => !c.busy && turnEnds(c).length === 1, 'the reply ended', LONG);
      assertEquals(host.studio.busyList().map((b) => b.state), ['background']);
      lab.open_(gate);
      await until(() => updateTexts(c).includes('The tests finished.') && !c.busy, "Claude Code's own cycle ended", LONG);
      assertEquals(host.studio.busyList(), []);
    });
  } finally {
    setTableReader(null);
  }
});

Deno.test('background shell: the keeper snapshot note keeps the task id and processes (a rebuilt chat goes on counting it)', async () => {
  await using lab = new ShellLab();
  const pidFile = lab.path('child');
  const c = await lab.open(['--held-turn', '--child-pid-file', pidFile]);
  const gate = lab.gate();
  await c.prompt(`bgshell:${gate}`);
  await until(() => !c.busy && turnEnds(c).length === 1, 'the reply ended', LONG);
  const note = c.snapshotNote() as Json;
  const shells = (note.state as Json).bgShells;
  assert(Array.isArray(shells) && shells.length === 1, JSON.stringify(shells));
  assertEquals((shells as unknown[][])[0][0], 'bfake1');
  assert(((shells as unknown[][])[0][1] as number[]).includes(Number(Deno.readTextFileSync(pidFile + '.shell'))));
  lab.open_(gate);
  await until(() => !c.backgroundShellsRunning(), 'the shell ended', LONG);
});

Deno.test('background shell: another agent with the same stream is not counted (only Claude Code is read this way)', async () => {
  await using lab = new ShellLab();
  const c = await lab.open(['--held-turn', '--not-claude']);
  const gate = lab.gate();
  await c.prompt(`bgshell:${gate}`);
  await until(() => !c.busy && turnEnds(c).length === 1, 'the reply ended', LONG);
  assert(!c.backgroundShellsRunning());
  lab.open_(gate);
});

Deno.test('descendants: a real child process of this process is listed while it runs, with its start time, and not after', async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ['eval', 'await new Promise((r) => setTimeout(r, 60000))'],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  const before = Date.now() / 1000;
  try {
    await until(() => (descendants(Deno.pid) ?? []).some((d) => d.pid === child.pid), 'the child listed', 15);
    const row = descendants(Deno.pid)!.find((d) => d.pid === child.pid)!;
    if (Deno.build.os === 'windows') assert(row.started !== null && Math.abs(row.started - before) < 30, String(row.started));
  } finally {
    child.kill('SIGKILL');
    await child.status;
  }
  await until(() => !(descendants(Deno.pid) ?? []).some((d) => d.pid === child.pid), 'the child gone', 15);
  assertEquals(descendants(0), null);
});

Deno.test("descendants: ps's etime", () => {
  assertEquals(elapsed('00:05'), 5);
  assertEquals(elapsed('01:02:03'), 3723);
  assertEquals(elapsed('2-01:02:03'), 2 * 86400 + 3723);
  assertEquals(elapsed('ELAPSED'), null);
});
