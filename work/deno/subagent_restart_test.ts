/**
 * Subagent landing bugs seen 2026-11-16 in the owner's lead chat (server/subagents/service.ts), without an agent:
 *   names     parallel Agent calls: the worktrees are made in call order but taken in start order, so a subagent ran in a worktree
 *             recorded for a sibling's call and landed under the sibling's description. The stream's launch message (claudeTool with
 *             the agentId) or PostToolUse moves the whole call back (description too); a worktree the stream already tied to an
 *             agent is the one that agent takes
 *   restart   the chat's live id changed (c533d888 -> 7e47dbe3, same conversation): the old subagents are adopted by the new chat;
 *             Claude Code's own files (agent-<id>.meta.json finished, the transcript's last stop) settle the ones still "running":
 *             finished = done (lands), ended otherwise = stopped, quiet for half an hour with its chat gone = stopped; the start
 *             sweep does the same for chats that are not open
 *   cap       only live subagents count: finished-but-unlanded and stopped ones never block a new one
 * Landing (scratch files, names on the commit, restart landing): work/deno/subagent_landing_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  claudeSubagentEnd,
  LOST_QUIET_S,
  MAX_PER_CHAT,
  readSubagents,
  type SubagentChat,
  type SubagentRecord,
  SubagentWorktrees,
  TEXTS,
} from '../../app/server/subagents/service.ts';
import { join } from '../../app/server/platform/path.ts';

function git(cwd: string, ...args: string[]): string {
  const out = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], cwd, stdout: 'piped', stderr: 'piped' })
    .outputSync();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout);
}

function repo(dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  Deno.writeTextFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

function chatOf(id: string, project: string, configDir?: string, session = 's1'): SubagentChat {
  return {
    id,
    provider: 'claude',
    lasting: `claude:${session}`,
    folder: project,
    project,
    hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false, ...(configDir ? { configDir } : {}) },
  };
}

/** Claude Code's files for one subagent: agent-<id>.meta.json and its transcript, as Claude Code 2.1 writes them. */
function claudeFiles(config: string, session: string, agentId: string, o: { finished: boolean; stop?: string; description?: string; ageS?: number }) {
  const dir = join(config, 'projects', 'C--some-project', session, 'subagents');
  Deno.mkdirSync(dir, { recursive: true });
  const meta = { agentType: 'general-purpose', description: o.description ?? 'x', toolUseId: 'toolu_x', ...(o.finished ? { finished: true } : {}) };
  Deno.writeTextFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  const lines = [
    { type: 'user', message: { role: 'user', content: 'do it' } },
    { type: 'assistant', message: { role: 'assistant', stop_reason: o.stop ?? 'tool_use', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'attachment', attachment: {} }, // says nothing of the end
  ];
  const transcript = join(dir, `agent-${agentId}.jsonl`);
  Deno.writeTextFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (o.ageS) {
    const t = new Date(Date.now() - o.ageS * 1000);
    Deno.utimeSync(transcript, t, t);
  }
}

const cleanup = (project: string, recs: SubagentRecord[]) => {
  for (const r of recs) {
    if (!r.path) continue;
    try {
      git(project, 'worktree', 'unlock', r.path);
    } catch { /* not locked */ }
    try {
      git(project, 'worktree', 'remove', '--force', r.path);
    } catch { /* gone */ }
  }
};

Deno.test('names: parallel Agent calls bound in another order get their own call back (stream, then PostToolUse); stream-tied worktrees bind right', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subnames-' });
  const project = repo(join(dir, 'proj'));
  const state = join(dir, 'state');
  const chat = chatOf('a1a1a1a1aa', project);
  const service = new SubagentWorktrees(state, join(state, 'worktrees'), (id) => (id === chat.id ? chat : null));
  try {
    const pre = (n: string, desc: string) =>
      service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: `toolu_${n}`, tool_input: { prompt: 'x', description: desc, run_in_background: true } });
    const bind = async (agent: string) => (await service.hook('worktree-create', chat.id, { name: `agent-${agent}` })).body;
    const byAgent = (agent: string) => Object.values(readSubagents(state)).find((r) => r.agentId === agent)!;
    // three calls in one message (as the owner's lead did): prepared A, B, C in call order...
    await pre('A', 'Inbox v3.1: design + toast research');
    await pre('B', 'File editor: update design + spike');
    await pre('C', 'Performance: measure and fix');
    // ...but the agents start in another order: each takes the oldest prepared worktree, so all three are paired wrongly
    const pathOfB = await bind('agB'); // takes A's
    await bind('agC'); // takes B's
    await bind('agA'); // takes C's
    assertEquals(byAgent('agB').description, 'Inbox v3.1: design + toast research', 'the bug: agB sits in the record of call A');
    // the stream's launch message pairs call B with agB (claudeTool with the agentId; the agent can't forge it): the calls swap
    await service.claudeTool(chat.id, 'Agent', 'toolu_B', {}, '', 'agB');
    assertEquals([byAgent('agB').description, byAgent('agB').toolUseId, byAgent('agB').acpAgentId], ['File editor: update design + spike', 'toolu_B', 'agB']);
    assertEquals(byAgent('agB').path, pathOfB, 'the worktree stays with the agent that works in it');
    // PostToolUse (async_launched) pairs the others; the whole call moves with each fix, so the permutation ends right
    await service.hook('post-agent', chat.id, { tool_name: 'Agent', tool_use_id: 'toolu_A', tool_response: { agentId: 'agA', status: 'async_launched' } });
    await service.hook('post-agent', chat.id, { tool_name: 'Agent', tool_use_id: 'toolu_C', tool_response: { agentId: 'agC', status: 'async_launched' } });
    assertEquals(
      ['agA', 'agB', 'agC'].map((a) => [byAgent(a).toolUseId, byAgent(a).description]),
      [['toolu_A', 'Inbox v3.1: design + toast research'], ['toolu_B', 'File editor: update design + spike'], ['toolu_C', 'Performance: measure and fix']],
    );
    assert(byAgent('agA').background && byAgent('agC').background);
    assertEquals(service.worktreeOf(chat.id, 'toolu_B'), pathOfB, 'allow-rule parity follows the fix');

    // the stream tied a call to its agent before the agent asked for a worktree: that agent takes that call's worktree
    await pre('D', 'sub D');
    await pre('E', 'sub E');
    await service.claudeTool(chat.id, 'Agent', 'toolu_E', {}, '', 'agE');
    await bind('agE');
    await bind('agD');
    assertEquals([byAgent('agE').description, byAgent('agD').description], ['sub E', 'sub D']);
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // a background spare
    cleanup(project, Object.values(readSubagents(state)));
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('cap: only live subagents count; finished (waiting to land) and stopped ones never block a new one', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subcap-' });
  const project = repo(join(dir, 'proj'));
  const state = join(dir, 'state');
  const chat = chatOf('b2b2b2b2aa', project);
  const service = new SubagentWorktrees(state, join(state, 'worktrees'), (id) => (id === chat.id ? chat : null));
  const decision = async (n: number) =>
    JSON.parse((await service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: `toolu_${n}`, tool_input: { prompt: 'x' } })).body)
      ?.hookSpecificOutput ?? {};
  try {
    for (let n = 0; n < MAX_PER_CHAT; n++) {
      assertEquals((await decision(n)).updatedInput?.isolation, 'worktree', `subagent ${n}`);
      await service.hook('worktree-create', chat.id, { name: `agent-cap${n}` });
    }
    assertEquals((await decision(99)).permissionDecisionReason, TEXTS.cap, `${MAX_PER_CHAT} running: the next is refused`);
    // they all finish (beta 11: done-but-unlanded ones kept the slot) or are stopped (kept for the main agent)
    for (let n = 0; n < MAX_PER_CHAT; n++) {
      if (n % 2) await service.hook('subagent-stop', chat.id, { agent_id: `cap${n}`, agent_type: 'general-purpose' });
      else await service.acpEnded(chat.id, `cap${n}`, 'cancelled');
    }
    const states = Object.values(readSubagents(state)).filter((r) => r.agentId.startsWith('cap')).map((r) => r.state).sort();
    assertEquals(new Set(states), new Set(['done', 'stopped']));
    for (let n = 100; n < 100 + MAX_PER_CHAT; n++) {
      assertEquals((await decision(n)).updatedInput?.isolation, 'worktree', `a new subagent beside ${MAX_PER_CHAT} finished ones (${n})`);
      await service.hook('worktree-create', chat.id, { name: `agent-cap${n}` });
    }
    assertEquals((await decision(999)).permissionDecisionReason, TEXTS.cap, 'the live ones still hit the cap');
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    cleanup(project, Object.values(readSubagents(state)));
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('restart: a new chat of the same conversation adopts the old one\'s subagents; Claude Code\'s files settle the running ones', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subadopt-' });
  const project = repo(join(dir, 'proj'));
  const other = repo(join(dir, 'other'));
  const state = join(dir, 'state');
  const config = join(dir, 'claude');
  const session = 'a16e40ca-fbee-46c2-9e61-388e4b23cb4e';
  const old = chatOf('c533d888aa', project, config, session);
  const fresh = chatOf('7e47dbe3aa', project, config, session);
  const stranger = chatOf('99999999aa', other, config, 'another-session');
  const open = new Set([old.id, stranger.id]);
  const chats = [old, fresh, stranger];
  const service = new SubagentWorktrees(state, join(state, 'worktrees'), (id) => (open.has(id) ? chats.find((c) => c.id === id)! : null));
  try {
    const start = async (c: SubagentChat, agent: string, desc: string) => {
      await service.hook('pre-tool', c.id, { tool_name: 'Agent', tool_use_id: `toolu_${agent}`, tool_input: { prompt: 'x', description: desc, run_in_background: true } });
      await service.hook('worktree-create', c.id, { name: `agent-${agent}` });
    };
    await start(old, 'agDone', 'File editor: update design + spike');
    await start(old, 'agKilled', 'Test builds update in-app');
    await start(old, 'agLost', 'Build Inbox v3.1 phases 1-3');
    await start(old, 'agLive', 'still at work');
    await start(old, 'agEnded', 'ended before the restart');
    await service.hook('subagent-stop', old.id, { agent_id: 'agEnded', agent_type: 'general-purpose' });
    await start(stranger, 'agOther', 'another conversation');
    const byAgent = (agent: string) => Object.values(readSubagents(state)).find((r) => r.agentId === agent)!;
    // the PC crashed; AIB opened the conversation again under a new live id. The old chat's hooks now answer 503
    open.delete(old.id);
    open.add(fresh.id);
    assertEquals((await service.hook('subagent-stop', old.id, { agent_id: 'agDone', agent_type: 'general-purpose' })).status, 503);
    // Claude Code wrote what became of each (it kept running in the background while AIB was away)
    claudeFiles(config, session, 'agDone', { finished: true, stop: 'end_turn', description: 'File editor: update design + spike' });
    claudeFiles(config, session, 'agKilled', { finished: true, stop: 'tool_use' });
    claudeFiles(config, session, 'agLost', { finished: false, ageS: LOST_QUIET_S + 60 });
    claudeFiles(config, session, 'agLive', { finished: false, ageS: 5 });
    const adopted = await service.adoptPrevious(fresh.id);
    assertEquals(adopted.map((r) => r.agentId).sort(), ['agDone', 'agEnded', 'agKilled', 'agLive', 'agLost']);
    for (const a of ['agDone', 'agKilled', 'agLost', 'agLive', 'agEnded']) {
      assertEquals([byAgent(a).chat, byAgent(a).adoptedFrom], [fresh.id, old.id], a);
    }
    assertEquals(byAgent('agOther').chat, stranger.id, "another conversation's subagent is never taken");
    assertEquals(byAgent('agDone').state, 'done', 'finished at a natural stop: done, so it lands');
    assertEquals([byAgent('agKilled').state, byAgent('agKilled').stoppedWhy], ['stopped', 'it ended while AIB was not watching it']);
    assertEquals([byAgent('agLost').state, byAgent('agLost').stoppedWhy], ['stopped', 'AIB lost track of it when its chat restarted']);
    assertEquals(byAgent('agLive').state, 'running', 'still writing its transcript: left running');
    assertEquals(byAgent('agEnded').state, 'done');
    // the new chat's own hooks and stream now reach the adopted one
    await service.hook('subagent-stop', fresh.id, { agent_id: 'agLive', agent_type: 'general-purpose' });
    assertEquals(byAgent('agLive').state, 'done');
    assertEquals(service.activity(fresh.id).agDone, { where: 'Own worktree', landing: 'Lands when the turn ends' });
    // a later call is a no-op
    assertEquals(await service.adoptPrevious(fresh.id), []);
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    cleanup(project, Object.values(readSubagents(state)).filter((r) => r.folder === project));
    cleanup(other, Object.values(readSubagents(state)).filter((r) => r.folder === other));
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('startup: the sweep settles running subagents of chats that are not open from Claude Code\'s files (it never guesses)', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subsweep-' });
  const project = repo(join(dir, 'proj'));
  const state = join(dir, 'state');
  const config = join(dir, 'claude');
  const was = Deno.env.get('CLAUDE_CONFIG_DIR');
  Deno.env.set('CLAUDE_CONFIG_DIR', config); // the sweep has no chat to name the config folder: the environment's
  const chat = chatOf('d4d4d4d4aa', project, undefined, 'sess-sweep');
  let open = true;
  const service = new SubagentWorktrees(state, join(state, 'worktrees'), (id) => (open && id === chat.id ? chat : null));
  try {
    for (const a of ['swDone', 'swQuiet']) {
      await service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: `toolu_${a}`, tool_input: { prompt: 'x', description: a } });
      await service.hook('worktree-create', chat.id, { name: `agent-${a}` });
    }
    open = false; // AIB restarts; the chat is not open (yet)
    claudeFiles(config, 'sess-sweep', 'swDone', { finished: true, stop: 'end_turn' });
    claudeFiles(config, 'sess-sweep', 'swQuiet', { finished: false, ageS: LOST_QUIET_S * 4 });
    await service.sweep();
    const byAgent = (agent: string) => Object.values(readSubagents(state)).find((r) => r.agentId === agent)!;
    assertEquals(byAgent('swDone').state, 'done', 'finished while AIB was away: done (it lands when its conversation is open)');
    assertEquals(byAgent('swQuiet').state, 'running', 'a keeper may still hold its chat: the sweep only acts on an end Claude Code wrote');
  } finally {
    if (was === undefined) Deno.env.delete('CLAUDE_CONFIG_DIR');
    else Deno.env.set('CLAUDE_CONFIG_DIR', was);
    await new Promise((r) => setTimeout(r, 300));
    cleanup(project, Object.values(readSubagents(state)));
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("claudeSubagentEnd reads Claude Code's meta file and the transcript's last message only", () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-subend-' });
  try {
    claudeFiles(dir, 's9', 'e1', { finished: true, stop: 'end_turn', description: 'one' });
    claudeFiles(dir, 's9', 'e2', { finished: true, stop: 'tool_use' });
    claudeFiles(dir, 's9', 'e3', { finished: false, ageS: 120 });
    assertEquals(claudeSubagentEnd(dir, 's9', 'e1')?.how, 'end_turn');
    assertEquals(claudeSubagentEnd(dir, 's9', 'e1')?.description, 'one');
    assertEquals(claudeSubagentEnd(dir, 's9', 'e2')?.how, 'ended');
    const running = claudeSubagentEnd(dir, 's9', 'e3')!;
    assert(running.how === 'running' && running.quietS >= 110, JSON.stringify(running));
    assertEquals(claudeSubagentEnd(dir, 's9', 'nope'), null);
    assertEquals(claudeSubagentEnd(dir, '..', 'e1'), null, 'ids are checked before any path is made');
    assertEquals(claudeSubagentEnd(dir, 's9', '../e1'), null);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
