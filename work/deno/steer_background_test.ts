/**
 * Background commands after a steer (server/acp/connection.ts toolBackground / stopBackgroundTool, platform/kill_verified.ts):
 * the row is marked from each agent's own signal (Claude Code's meta and text, OMP's details.async, a Codex command still open at
 * its turn's end), and Stop kills only processes AIB can prove are that command's: noted as (pid, start time) when it moved, still
 * the agent's descendants with the same start time at the kill, and what they started since; leaf first. T19, T20, T21 (B5, B6).
 * The commands are real processes the puppet agent starts (_steer_puppet.ts #spawn).
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { type Json, type Puppet, SteerLab } from './_steer.ts';
import { backgroundTask, type Connection, NotStoppable } from '../../outputs/agent-studio/server/acp/connection.ts';
import { descendants, setTableReader } from '../../outputs/agent-studio/server/platform/descendants.ts';
import { killVerified } from '../../outputs/agent-studio/server/platform/kill_verified.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const bg = (c: Connection) => c.public().toolBackground as Record<string, { state: string; stoppable: boolean }>;

function bashCall(id: string): Json {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'Terminal',
    kind: 'execute',
    status: 'pending',
    _meta: { claudeCode: { toolName: 'Bash' } },
  };
}

/** What claude-agent-acp 0.97 sent when a steer moved a running Bash to the background (recording C1). */
function movedByClaude(id: string, task: string): Json {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    status: 'completed',
    rawOutput: `Command was moved to the background (ID: ${task}) so that a message that arrived while it was running can reach you; ` +
      'it was not interrupted. Output is being written to: C:\\tmp\\tasks\\' + task + '.output',
    _meta: { claudeCode: { toolName: 'Bash', toolResponse: { backgroundTaskId: task, backgroundedToDeliverMessage: true } } },
  };
}

async function shell(c: Connection, p: Puppet, id: string, tag: string, deep = false): Promise<number> {
  await p.update(bashCall(id));
  await until(() => c.events.some((e) => e.kind === 'update' && ((e.data as Json).update as Json).toolCallId === id), 'the tool call');
  await pause(50);
  return await p.spawn(tag, deep);
}

Deno.test({
  name: "T19 (B5): Stop kills the command's processes and what they started, leaf first; the agent and its older processes live on",
  ...T,
  async fn() {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('claude');
    const older = await p.spawn('mcp-server'); // started with the chat, like an MCP server
    await c.prompt('run the tests', 'm1');
    const prompt = await p.take('session/prompt');
    const command = await shell(c, p, 'tc1', 'tests', true);
    await p.update(movedByClaude('tc1', 'b1'));
    await until(() => bg(c).tc1?.state === 'running', 'marked running in the background');
    assertEquals(bg(c).tc1, { state: 'running', stoppable: true });
    assertEquals(c.backgroundShells(), ['b1']);
    await until(() => (descendants(command) ?? []).length === 1, 'the command started a child of its own', 15);
    const grandchild = descendants(command)![0].pid;
    const result = await c.stopBackgroundTool('tc1');
    assertEquals([result.state, result.killed], ['stopped', 2]);
    await until(() => !pidAlive(command) && !pidAlive(grandchild), 'both gone', 10);
    assert(pidAlive(older), "the agent's older process lives on");
    assert(c.poll() === null && !c.closed, 'the agent lives on');
    assertEquals(bg(c).tc1, { state: 'stopped', stoppable: false });
    assertEquals(c.backgroundShells(), []);
    // The page reads the row's state from its updates: AIB's own tool_call_update with `background`, at each change.
    assertEquals(
      c.events.filter((e) => e.kind === 'update' && ((e.data as Json).update as Json).background)
        .map((e) => ((e.data as Json).update as Json).background),
      [{ state: 'running', stoppable: true }, { state: 'stopped', stoppable: false }],
    );
    let refused = '';
    await c.stopBackgroundTool('tc1').catch((e) => (refused = e.name));
    assertEquals(refused, 'NotStoppable', 'once stopped, nothing more to stop');
    await p.reply(prompt.id, { stopReason: 'end_turn' });
    await until(() => !c.busy, 'done');
  },
});

Deno.test({
  name: "T20 (B5): no Stop when the processes could be another command's, for an MCP tool, or when they cannot be listed",
  ...T,
  async fn() {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('claude');
    await c.prompt('go', 'm1');
    const prompt = await p.take('session/prompt');
    // Two shell commands running: a new process could be either one's.
    await p.update(bashCall('other'));
    const first = await shell(c, p, 'tc1', 'one');
    await p.update(movedByClaude('tc1', 'b1'));
    await until(() => bg(c).tc1 !== undefined, 'marked');
    assertEquals(bg(c).tc1, { state: 'running', stoppable: false });
    let refused: unknown = null;
    await c.stopBackgroundTool('tc1').catch((e) => (refused = e));
    assert(refused instanceof NotStoppable);
    assert(pidAlive(first), 'nothing was killed');
    // An MCP tool moved to the background: never stoppable, whatever runs.
    await p.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp1',
      title: 'search',
      kind: 'other',
      status: 'pending',
      _meta: { claudeCode: { toolName: 'mcp__web__search' } },
    });
    await p.spawn('mcp-child');
    await p.update({
      ...movedByClaude('mcp1', 'b2'),
      _meta: { claudeCode: { toolName: 'mcp__web__search', toolResponse: { backgroundTaskId: 'b2' } } },
    });
    await until(() => bg(c).mcp1 !== undefined, 'marked');
    assertEquals(bg(c).mcp1.stoppable, false);
    // The process list cannot be read when the command moves: it counts as running, without Stop.
    setTableReader(() => null);
    try {
      await p.update(bashCall('tc3'));
      await p.update(movedByClaude('tc3', 'b3'));
      await until(() =>
        c.events.some((e) =>
          e.kind === 'update' && ((e.data as Json).update as Json).toolCallId === 'tc3' &&
          ((e.data as Json).update as Json).status === 'completed'
        ), 'the update');
      await pause(50);
    } finally {
      setTableReader(null);
    }
    assertEquals(bg(c).tc3, { state: 'running', stoppable: false });
    await p.reply(prompt.id, { stopReason: 'end_turn' });
    await until(() => !c.busy, 'done');
  },
});

Deno.test({
  name: 'C2: a Claude helper a steer moved to the background is marked running without Stop (no process of its own), done when it ends',
  ...T,
  async fn() {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('claude');
    await c.prompt('go', 'm1');
    const prompt = await p.take('session/prompt');
    await p.update({ sessionUpdate: 'subagent_update', sessionId: 'h1', title: 'general-purpose', state: { state: 'running' } });
    const reply = (from: string, text: string, id = 'toolu_agent') => ({
      sessionUpdate: 'session_message',
      messageId: `${id}:reply`,
      senderSessionId: from,
      recipientSessionId: 's1',
      content: [{ type: 'text', text }],
    });
    const launched = 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: h1';
    await p.update(reply('h1', 'Here is what I found.', 'toolu_other')); // a helper's ordinary answer
    await p.update(reply('nobody', launched, 'toolu_ghost')); // not a helper AIB knows
    await p.update(reply('h1', launched));
    await until(() => bg(c).toolu_agent !== undefined, 'the helper marked');
    assertEquals(bg(c), { toolu_agent: { state: 'running', stoppable: false, helper: 'h1' } });
    const marks = c.events.filter((e) => e.kind === 'update' && ((e.data as Json).update as Json).background);
    assertEquals(((marks.at(-1)!.data as Json).update as Json).background, { state: 'running', stoppable: false, helper: 'h1' }, 'the page is told');
    let refused: unknown = null;
    await c.stopBackgroundTool('toolu_agent').catch((e) => (refused = e));
    assert(refused instanceof NotStoppable, 'a helper is not a process AIB can verify and kill');
    await p.update({ sessionUpdate: 'subagent_update', sessionId: 'h1', state: { state: 'idle', stopReason: 'end_turn' } });
    await until(() => bg(c).toolu_agent?.state === 'done', 'done when the helper ended');
    assertEquals(bg(c).toolu_agent, { state: 'done', stoppable: false, helper: 'h1' });
    await p.reply(prompt.id, { stopReason: 'end_turn' });
    await until(() => !c.busy, 'done');
  },
});

Deno.test('T20 (B5): killVerified kills only verified processes: a wrong start time (a reused pid) or a non-descendant is left alone', async () => {
  // root 100 -> 200 (the command) -> 300 -> 400; 500 is another child of the agent; 900 is no descendant at all.
  const rows = [[100, 1, 900], [200, 100, 1000], [300, 200, 1001], [400, 300, 1002], [500, 100, 1003], [900, 1, 1]];
  setTableReader(() => new Map(rows.map(([pid, parentPid, started]) => [pid, { pid, parentPid, started }])));
  try {
    const order: number[] = [];
    const killer = (t: { pid: number }) => (order.push(t.pid), true);
    let result = await killVerified(100, [{ pid: 200, started: 1000 }], killer);
    assertEquals(order, [400, 300, 200], 'leaf first, the whole subtree, nothing else');
    assertEquals(result!.skipped, []);
    order.length = 0;
    result = await killVerified(100, [{ pid: 200, started: 990 }], killer);
    assertEquals([order, result!.skipped], [[], [200]], 'another start time: another process now has this pid');
    result = await killVerified(100, [{ pid: 900, started: 1 }], killer);
    assertEquals([order, result!.skipped], [[], [900]], 'not a descendant of the agent');
    setTableReader(() => null);
    assertEquals(await killVerified(100, [{ pid: 200, started: 1000 }], killer), null, 'cannot list: nothing is killed');
  } finally {
    setTableReader(null);
  }
});

Deno.test({
  name: 'Codex: a command still open when the turn ends is a background command; its completed update after the turn ends it',
  ...T,
  async fn() {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('codex');
    await c.prompt('run it', 'm1');
    const prompt = await p.take('session/prompt');
    await p.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-1',
      name: 'exec_command',
      kind: 'execute',
      title: 'npm test',
      status: 'in_progress',
    });
    await pause(100);
    const command = await p.spawn('npm');
    await p.text('4');
    await p.reply(prompt.id, { stopReason: 'end_turn' }); // recording X1: the turn ends while the command runs on
    await until(() => !c.busy, 'the turn ended');
    assertEquals(bg(c)['exec-1'], { state: 'running', stoppable: true });
    assertEquals(c.backgroundShells(), ['open:exec-1']);
    await p.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'exec-1',
      status: 'completed',
      _meta: { terminal_exit: { exit_code: 0 } },
    });
    await until(() => bg(c)['exec-1'].state === 'done', 'ended');
    assertEquals(c.backgroundShells(), []);
    assert(pidAlive(command)); // (the puppet's sleeper: the update is what the page goes by)
  },
});

Deno.test({
  name: 'OMP: a command backgrounded for a steer (details.async) runs on; a later completed without it ends it',
  ...T,
  async fn() {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('omp');
    await c.prompt('run it', 'm1');
    const prompt = await p.take('session/prompt');
    await p.update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_1', kind: 'execute', title: '$ for i in ...', status: 'pending' });
    await pause(100);
    await p.spawn('loop');
    const text = 'tick 1\n\nBackgrounded early to handle an incoming message; the command keeps running.\n\nBackgrounded as job bg_1 ' +
      '(killed once it has run 120s in total; `timeout: 0` disables the deadline); its output is injected into the conversation.';
    await p.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text }], details: { async: { state: 'running', jobId: 'bg_1', type: 'bash' } } },
    });
    await until(() => bg(c).toolu_1 !== undefined, 'marked');
    assertEquals(bg(c).toolu_1, { state: 'running', stoppable: true });
    await p.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      status: 'in_progress',
      rawOutput: { content: [{ type: 'text', text: 'tick 2' }], details: { async: { state: 'running', jobId: 'bg_1' } } },
    });
    await pause(100);
    assertEquals(bg(c).toolu_1.state, 'running', 'its streaming keeps it running');
    await p.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'finished' }], details: {} },
    });
    await until(() => bg(c).toolu_1.state === 'done', 'ended');
    await p.reply(prompt.id, { stopReason: 'end_turn' });
    await until(() => !c.busy, 'done');
  },
});

Deno.test('T21 (B6): every background signal is read, each from its own agent', () => {
  const claudeText = (rawOutput: string) => backgroundTask({ toolCallId: 't', rawOutput }, true);
  assertEquals(claudeText('Command running in background with ID: b7. Output is being written to: x'), 'b7');
  assertEquals(
    claudeText('Command was moved to the background (ID: b8) so that a message that arrived while it was running can reach you'),
    'b8',
  );
  assertEquals(claudeText('Command exceeded the 2m timeout and was moved to the background (ID: b9). Output is being written to: x'), 'b9');
  assertEquals(claudeText('Command was manually backgrounded by user with ID: b10. Output is being written to: x'), 'b10');
  assertEquals(claudeText('tick 1\nCommand running in background with ID: b11.'), null, "only the result's own opening counts");
  assertEquals(
    backgroundTask({ _meta: { claudeCode: { toolResponse: { backgroundTaskId: 'b12', backgroundedToDeliverMessage: true } } } }, true),
    'b12',
  );
  assertEquals(
    backgroundTask({ _meta: { claudeCode: { toolResponse: { backgroundTaskId: 'b12' } } } }, false),
    null,
    "Claude Code's meta is Claude Code's",
  );
  assertEquals(backgroundTask({ rawOutput: { content: [], details: { async: { state: 'running', jobId: 'bg_3' } } } }, false), 'bg_3');
  assertEquals(backgroundTask({ rawOutput: { content: [], details: { async: { state: 'completed', jobId: 'bg_3' } } } }, false), null);
  assertEquals(
    backgroundTask({ rawOutput: { content: [{ type: 'text', text: 'x\n\nBackgrounded as job bg_4 (killed once...)' }] } }, false),
    'bg_4',
  );
  assertEquals(backgroundTask({ rawOutput: 'Command running in background with ID: b7.' }, false), null);
  assertEquals(backgroundTask({ rawOutput: 'all tests passed' }, true), null);
});
