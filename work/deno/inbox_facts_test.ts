/**
 * The agent connection's facts for the inbox (server/acp/connection.ts attention(), inbox-rules.js), with the fake agent:
 *   - a turn the agent answers with an error is Failed (with the agent's words and the kind of failure); a Stop never is; sending
 *     again clears it;
 *   - a reply that asks you something in plain text (rule R6) is Asks, with the question; a short reply never is;
 *   - Claude Code's helpers keep the chat working ("2 subagents running"), and so does the follow-up window after the last one ended;
 *     another agent's helpers do not (phase 1 counts Claude Code's only);
 *   - the agent host's tray counts the same chats as the page's badge (Studio.blockedChats).
 */
import { assert, assertEquals } from './_assert.ts';
import { events, type Json, Lab, until } from './_connection.ts';
import type { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { AgentHost } from '../../outputs/agent-studio/server/host/agent_host.ts';
import { INBOX } from '../../outputs/agent-studio/server/attention/inbox_rules.ts';

const LONG = 60; // a deadline, not a delay
const turnEnds = (c: Connection) => events(c, 'turn_end').length;
const QUESTION = 'I went through the branch, ran the targeted tests and read the logs. The build passes and the notes are updated. ' +
  'Two ways to go from here: ship it now, or wait for the full suite. Should I start the release now?';

Deno.test('inbox facts: an error the agent reports is Failed until you send again; a Stop is never Failed', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--limits', '--held-turn']);
  await c.prompt('quota:1999999999', 'm1');
  await until(() => !c.busy && events(c, 'error').length === 1, 'the failed turn', LONG);
  const a = c.attention();
  assertEquals(a.phase, 'failed');
  assertEquals(a.error, 'Weekly credits used up');
  assertEquals(a.failKind, 'limit');
  assert(INBOX.secondsOf(a.failedAt) > 0);
  assertEquals(INBOX.phaseOf(a, {}, Date.now() / 1000), 'failed');
  assertEquals(INBOX.phaseOf(a, { handledAt: Date.now() / 1000 + 1 }, Date.now() / 1000), 'idle', 'Mark handled clears it');
  // sending again clears it
  await c.prompt('hello', 'm2');
  await until(() => !c.busy && turnEnds(c) === 1, 'the next reply', LONG);
  assertEquals(c.attention().failedAt, null);
  assertEquals(c.attention().phase, 'idle');
  // a Stop: the turn ends cancelled, nothing failed
  const s = await lab.open(['--cancel-aware']);
  await s.prompt('wait', 's1');
  s.cancel();
  await until(() => !s.busy, 'stopped', LONG);
  assertEquals((events(s, 'turn_end').at(-1)!.data as Json).stopReason, 'cancelled');
  assertEquals(s.attention().failedAt, null);
  assertEquals(s.attention().asksAt, null);
  assert(s.attention().phase !== 'failed');
});

Deno.test('inbox facts: a reply that asks you something is Asks with its question; a short reply or a statement is not', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--held-turn']);
  await c.prompt(QUESTION, 'm1');
  await until(() => !c.busy && turnEnds(c) === 1, 'the reply', LONG);
  let a = c.attention();
  assertEquals(a.phase, 'asks');
  assertEquals(a.question, 'Should I start the release now?');
  assert(INBOX.secondsOf(a.asksAt) > 0);
  await c.prompt('Which do you want?', 'm2'); // "Fixture reply: Which do you want?" is under 160 characters
  await until(() => !c.busy && turnEnds(c) === 2, 'the second reply', LONG);
  a = c.attention();
  assertEquals(a.asksAt, null);
  assertEquals(a.phase, 'idle');
  await c.prompt(QUESTION.replace('Should I start the release now?', 'I will start the release once the suite is green.'), 'm3');
  await until(() => !c.busy && turnEnds(c) === 3, 'the third reply', LONG);
  assertEquals(c.attention().phase, 'idle');
});

Deno.test("inbox facts: Claude Code's helpers keep the chat working, then the follow-up window; another agent's do not", async () => {
  await using lab = new Lab();
  const c = await lab.open(['--held-turn']);
  const gate = lab.path('gate-helper');
  await c.prompt(`helper:${gate}`, 'm1');
  await until(() => !c.busy && turnEnds(c) === 1, 'the reply ended while the helper runs', LONG);
  let a = c.attention();
  assertEquals(a.state, 'idle', 'the old state is unchanged (quit, idle exit and the keeper read it)');
  assertEquals(a.helpers, 1);
  assertEquals(a.phase, 'working');
  assertEquals(INBOX.helpersLine(a.helpers as number), '1 subagent running');
  assertEquals(INBOX.phaseOf(a, { yourTurnAt: Date.now() / 1000 }, Date.now() / 1000), 'working', 'not Finished while it runs');
  Deno.writeTextFileSync(gate, 'go'); // the helper ends; Claude Code starts its own follow-up a moment later
  await until(() => c.attention().helpers === 0, 'the helper ended', LONG);
  a = c.attention();
  if (!c.busy) {
    // between the helper's end and the follow-up cycle: the follow-up window keeps it working
    assert(INBOX.secondsOf(a.followUntil) > Date.now() / 1000, JSON.stringify(a));
    assertEquals(a.phase, 'working');
  }
  Deno.writeTextFileSync(gate + '.end', 'go'); // the follow-up cycle ends
  await until(() => !c.busy && turnEnds(c) === 2, 'the follow-up cycle ended', LONG);
  a = c.attention();
  assertEquals(a.followUntil, null, 'the follow-up came: the window is closed');
  assertEquals(a.phase, 'idle');

  const other = await lab.open(['--held-turn', '--not-claude']);
  const gate2 = lab.path('gate-other');
  await other.prompt(`helper:${gate2}`, 'n1');
  await until(() => Object.keys(other.public().subagents as Json).length > 0, 'the other agent announced its helper', LONG);
  assertEquals(other.attention().helpers, 0, 'phase 1: only Claude Code helpers are counted');
  Deno.writeTextFileSync(gate2, 'go');
  Deno.writeTextFileSync(gate2 + '.end', 'go');
  await until(() => turnEnds(other) >= 1 && !other.busy, 'the other agent ended its turn', LONG);
  assertEquals(other.attention().helpers, 0);
  assertEquals(other.attention().phase, 'idle', 'its turn ended: not held working by helpers AIB does not count');
});

Deno.test('inbox facts: the agent host counts the chats blocked on you like the badge does (failed + asks; not a finished one)', async () => {
  await using lab = new Lab();
  const host = new AgentHost({ stateDir: lab.dir, port: 0 } as never, 30, 0, { exitUnattachedSeconds: 10 });
  try {
    const studio = host.studio;
    const failed = await lab.open(['--limits', '--held-turn']);
    const asks = await lab.open(['--held-turn']);
    const done = await lab.open(['--held-turn']);
    for (const c of [failed, asks, done]) studio.connections.set(c.id, c);
    await failed.prompt('quota:1999999999', 'a');
    await asks.prompt(QUESTION, 'b');
    await done.prompt('all done here', 'c');
    await until(() => [failed, asks, done].every((c) => !c.busy) && turnEnds(asks) === 1 && turnEnds(done) === 1, 'all three', LONG);
    assertEquals(studio.blockedChats(), 2);
    const listed = [failed, asks, done].map((c) => ({ attention: c.attention() as Json }));
    assertEquals(INBOX.countBlocked(listed, Date.now() / 1000), 2);
  } finally {
    host.studio.connections.clear();
    await host.studio.close();
  }
});
