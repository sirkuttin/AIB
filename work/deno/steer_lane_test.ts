/**
 * Steer-on-send, server side (server/acp/connection.ts steer lane): a message sent while the agent works goes to it now through
 * `_session/steering`, held while an approval or question is open, and falls back to an ordinary prompt when the agent's turn is
 * over. The agent end is a Puppet (_steer_puppet.ts) the test drives with the shapes of work/steer-recordings. Each test names the
 * architect-review break (B..) and test (T..) it covers (private/designs/send-while-working/architect-review-2026-11-12.md).
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { type Json, promptText, SteerLab, turnEnds, userEvents } from './_steer.ts';
import { CODEX_UNREAD_NOTE, STEER_FAILED_NOTE } from '../../outputs/agent-studio/server/acp/connection.ts';

const lane = (c: { public(): Json }) => (c.public().steerLane as Json[]).map((i) => [i.text, i.state, i.heldReason ?? '']);
const queued = (c: { queuePublic(): Json }) => (c.queuePublic().items as Json[]).map((i) => [i.text, i.note]);

Deno.test('T27/T24: steerable only while our turn runs on a steering agent; Enter steers with idleBehavior, in order, one at a time', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('claude');
  const idle = c.public();
  assertEquals([idle.steerable, idle.steerAgent, idle.steerLane, idle.toolBackground], [false, 'claude', [], {}]);
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  assertEquals(c.public().steerable, true);
  const sends = [c.steer('one', 's1'), c.steer('two', 's2'), c.steer('three', 's3')];
  const first = await p.take('_session/steering');
  assertEquals((first.params as Json)._meta, { steering: { idleBehavior: 'promptRequired' } }, 'the idleBehavior meta is mandatory');
  assertEquals(promptText(first), 'one');
  await pause(200);
  assertEquals(p.all('_session/steering').length, 1, 'the next waits for this answer');
  assertEquals(lane(c), [['one', 'sending', ''], ['two', 'sending', ''], ['three', 'sending', '']]);
  await p.reply(first.id, { outcome: 'injected' });
  const second = await p.take('_session/steering');
  assertEquals(promptText(second), 'two');
  await p.reply(second.id, { outcome: 'injected' });
  const third = await p.take('_session/steering');
  assertEquals(promptText(third), 'three');
  await p.reply(third.id, { outcome: 'injected' });
  assertEquals((await Promise.all(sends)).map((a) => a.state), ['injected', 'injected', 'injected']);
  // No adapter echoes a steered message: AIB shows the user's bubble itself, tagged.
  assertEquals(userEvents(c).map((u) => [u.text, u.steered ?? false]), [['go', false], ['one', true], ['two', true], ['three', true]]);
  assertEquals(lane(c), []);
  assertEquals(c.promptReceipts.get('s1')?.state, 'injected');
  const again = await c.steer('one', 's1');
  assertEquals([again.duplicate, again.state], [true, 'injected'], 'a retry of the same id never sends twice');
  assertEquals(p.all('_session/steering').length, 3);
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'the turn ended');
  assertEquals(c.public().steerable, false);
  assertEquals(turnEnds(c), ['end_turn'], 'steers start no turn of their own');
});

Deno.test('T16/T17 (B2, B3): promptRequired while AIB still finishes the turn is no error; the message goes as the next prompt, same id', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('codex');
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  c.onTurnEnd = async () => await gate; // AIB's own end-of-turn work (Your turn, live sync) takes a moment
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  await until(() => turnEnds(c).length === 1, 'the turn end');
  assert(c.busy, 'AIB is still finishing that turn');
  const sending = c.steer('late', 's1');
  const steer = await p.take('_session/steering');
  await p.reply(steer.id, { outcome: 'promptRequired', reason: 'noRunningTurn' });
  const answer = await sending;
  assertEquals(answer.state, 'fallback');
  assertEquals(lane(c), [['late', 'fallback', '']]);
  assertEquals(c.error, '');
  release();
  const next = await p.take('session/prompt');
  assertEquals(promptText(next), 'late');
  assertEquals(c.promptReceipts.get('s1')?.state, 'working', 'not dropped as a duplicate of its steer receipt');
  assertEquals(userEvents(c).map((u) => [u.text, u.steered ?? false]), [['go', false], ['late', false]], 'a normal message, untagged');
  await p.reply(next.id, { stopReason: 'end_turn' });
  await until(() => !c.busy && turnEnds(c).length === 2, 'its turn ended');
  assertEquals(p.all('session/prompt').length, 2);
});

Deno.test('T23 (B8): held while a card is open; released by the answer, by the agent withdrawing it, and by the turn end', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('omp');
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  await p.permission(7);
  await until(() => c.permissions.size === 1, 'the approval');
  assertEquals((await c.steer('also this', 's1')).state, 'held');
  assertEquals(lane(c), [['also this', 'held', 'approval']]);
  await pause(200);
  assertEquals(p.all('_session/steering').length, 0, 'never steered while the card is open (OMP would cancel it)');
  c.permission([...c.permissions.keys()][0], 'allow_once');
  const answer = await p.answer(7);
  const steer = await p.take('_session/steering');
  assert(p.received.indexOf(answer) < p.received.indexOf(steer), 'the answer goes first, then the message');
  await p.reply(steer.id, { outcome: 'injected', queue: 'steering' });
  await until(() => !lane(c).length, 'sent');

  await p.permission(8, 'tc2');
  await until(() => c.permissions.size === 1, 'a second approval');
  assertEquals((await c.steer('second', 's2')).state, 'held');
  await p.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 8 } });
  const second = await p.take('_session/steering');
  assertEquals(promptText(second), 'second');
  await p.reply(second.id, { outcome: 'injected' });

  await p.send({
    jsonrpc: '2.0',
    id: 9,
    method: 'elicitation/create',
    params: { sessionId: 's1', mode: 'url', message: 'Sign in', url: 'https://example.com/x', elicitationId: 'e1' },
  });
  await until(() => c.elicitations.size === 1, 'a link request');
  assertEquals((await c.steer('third', 's3')).state, 'held');
  await p.send({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId: 'e1' } });
  const third = await p.take('_session/steering');
  assertEquals(promptText(third), 'third');
  await p.reply(third.id, { outcome: 'injected' });

  // Held at the turn's end: it goes as the next prompt, ahead of the after-turn queue, whose needs_you hold does not apply to it.
  await p.permission(10, 'tc4');
  await until(() => c.permissions.size === 1, 'a last approval');
  await c.queueAdd('after the turn', 'q1');
  assertEquals((await c.steer('fourth', 's4')).state, 'held');
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  const next = await p.take('session/prompt');
  assertEquals(promptText(next), 'fourth');
  assertEquals(c.queuePublic().reason, 'needs_you');
  await p.reply(next.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'its turn ended');
  await pause(200);
  assertEquals(p.all('session/prompt').length, 2, 'the after-turn message waits for Resume');
});

Deno.test('T24 (B9): messages held at the turn end: the first goes as a prompt, the rest are steered into its turn', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('omp');
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  await p.permission(3);
  await until(() => c.permissions.size === 1, 'the approval');
  await c.steer('a', 's1');
  await c.steer('b', 's2');
  assertEquals(lane(c), [['a', 'held', 'approval'], ['b', 'held', 'approval']]);
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  const next = await p.take('session/prompt');
  assertEquals(promptText(next), 'a');
  const steer = await p.take('_session/steering');
  assertEquals(promptText(steer), 'b');
  assert(p.received.indexOf(next) < p.received.indexOf(steer));
  await p.reply(steer.id, { outcome: 'injected' });
  await until(() => !lane(c).length, 'the lane drained');
  await p.reply(next.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'done');
  assertEquals(userEvents(c).map((u) => [u.text, u.steered ?? false]), [['go', false], ['a', false], ['b', true]]);
});

Deno.test('owner rule: the main agent idle (a helper card open, or nothing at all): Enter sends at once as a prompt', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('claude');
  await p.permission(4, 'helper-tool', 'helper-1'); // a background helper asks between turns
  await until(() => c.permissions.size === 1, "the helper's approval");
  const answer = await c.steer('hello', 's1');
  assertEquals(answer.state, 'prompted');
  const prompt = await p.take('session/prompt');
  assertEquals(promptText(prompt), 'hello');
  assertEquals(p.all('_session/steering').length, 0);
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'done');
});

Deno.test("T22 (B7, B8): Interrupt keeps a background helper's card, withdraws the turn's own, and moves held messages to the paused queue", async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('claude');
  await c.prompt('start a helper', 'm0');
  const first = await p.take('session/prompt');
  await p.update({ sessionUpdate: 'subagent_update', sessionId: 'helper-1', title: 'Explore', state: 'running' });
  await p.reply(first.id, { stopReason: 'end_turn' });
  await until(() => !c.busy && c.helpersRunning(), 'the helper runs on in the background');
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  await p.permission(20, 'main-tool');
  await p.permission(21, 'helper-tool', 'helper-1');
  await until(() => c.permissions.size === 2, 'both approvals');
  assertEquals((await c.steer('held one', 's1')).state, 'held');
  c.cancel();
  assertEquals((await p.answer(20)).result, { outcome: { outcome: 'cancelled' } });
  await p.take('session/cancel');
  await pause(150);
  assert(!p.received.some((m) => m.id === 21 && !m.method), "the background helper's approval stays open");
  assertEquals(c.permissions.size, 1);
  assertEquals(lane(c), []);
  assertEquals(queued(c), [['held one', '']]);
  assertEquals(c.queuePublic().reason, 'interrupted');
  await p.reply(prompt.id, { stopReason: 'cancelled' });
  await until(() => !c.busy, 'stopped');
  await pause(200);
  assertEquals([p.all('session/prompt').length, p.all('_session/steering').length], [2, 0], 'nothing sent: paused');
});

Deno.test('B14: a cancelled stopReason the agent reports on its own (OMP after a steer) is no Interrupt: the queue goes on', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('omp');
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  await c.queueAdd('next', 'q1');
  await p.reply(prompt.id, { stopReason: 'cancelled' });
  const next = await p.take('session/prompt');
  assertEquals(promptText(next), 'next');
  await p.reply(next.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'done');
});

Deno.test('B17 and agents without steering: slash commands and a non-steering agent wait for the turn end', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('claude');
  await p.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] });
  await until(() => c.breadth.commands.length === 1, 'the commands');
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  assertEquals((await c.steer('/compact', 'c1')).state, 'queued');
  assertEquals((await c.steer('/doc open notes', 'c2')).state, 'queued');
  const plain = c.steer('/not-a-command really', 'c3');
  const steer = await p.take('_session/steering');
  await p.reply(steer.id, { outcome: 'injected' });
  assertEquals((await plain).state, 'injected', 'a slash the agent does not offer is just text');
  assertEquals(queued(c).map((q) => q[0]), ['/compact', '/doc open notes']);
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  await p.reply((await p.take('session/prompt')).id, { stopReason: 'end_turn' });
  await p.reply((await p.take('session/prompt')).id, { stopReason: 'end_turn' });
  await until(() => !c.busy && !queued(c).length, 'all sent');

  const other = await lab.chat('plain', { steering: false });
  assertEquals(other.c.public().steerAgent, null);
  await other.c.prompt('go', 'm1');
  const theirs = await other.p.take('session/prompt');
  assertEquals(other.c.public().steerable, false);
  assertEquals((await other.c.steer('later', 's1')).state, 'queued');
  await other.p.reply(theirs.id, { stopReason: 'end_turn' });
  assertEquals(promptText(await other.p.take('session/prompt')), 'later');
  assertEquals(other.p.all('_session/steering').length, 0);
});

Deno.test('T28 (B12): a steer carries the <studio-context> note like a prompt, without the turn-start hook', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('claude');
  let notes = 0;
  let starts = 0;
  const sent: unknown[] = [];
  c.contextForPrompt = () => [`<studio-context>note ${++notes}</studio-context>`, `token ${notes}`];
  c.onTurnStart = () => void starts++;
  c.contextSent = (_c, token) => void sent.push(token);
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  assertEquals(promptText(prompt), '<studio-context>note 1</studio-context>|go');
  const sending = c.steer('and this', 's1');
  const steer = await p.take('_session/steering');
  assertEquals(promptText(steer), '<studio-context>note 2</studio-context>|and this');
  await p.reply(steer.id, { outcome: 'injected' });
  await sending;
  await until(() => sent.includes('token 2'), 'the note marked sent');
  assertEquals(starts, 1, 'no turn starts for a steer');
  assertEquals(userEvents(c).at(-1)!.text, 'and this', 'the bubble shows only what the user wrote');
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'done');
});

Deno.test('a steer the agent refuses waits in the after-turn queue with a note, and goes then with the same id', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('omp');
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  const sending = c.steer('please', 's1');
  await p.replyError((await p.take('_session/steering')).id, 'steering is busy');
  assertEquals((await sending).state, 'queued');
  assertEquals(queued(c), [['please', STEER_FAILED_NOTE]]);
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  const next = await p.take('session/prompt');
  assertEquals(promptText(next), 'please');
  assertEquals(c.promptReceipts.get('s1')?.state, 'working');
  await p.reply(next.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'done');
});

Deno.test('B13: Codex ends its turn with no answer after a steer: the message comes back paused, to send again', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('codex');
  await c.prompt('go', 'm1');
  const prompt = await p.take('session/prompt');
  const read = c.steer('read this', 's1');
  await p.reply((await p.take('_session/steering')).id, { outcome: 'injected' });
  await read;
  await p.text('Sure, 4.'); // answered: nothing comes back
  const lost = c.steer('and this?', 's2');
  await p.reply((await p.take('_session/steering')).id, { outcome: 'injected' });
  await lost;
  await p.reply(prompt.id, { stopReason: 'end_turn' }); // no output after the second steer
  await until(() => !c.busy, 'the turn ended');
  assertEquals(queued(c), [['and this?', CODEX_UNREAD_NOTE]]);
  assertEquals(c.queuePublic().reason, 'unknown');
  const item = (c.queuePublic().items as Json[])[0];
  assert(item.id !== 's2', 'a new id, so Resume really sends it again');
  await c.queueResume();
  const again = await p.take('session/prompt');
  assertEquals(promptText(again), 'and this?');
  await p.reply(again.id, { stopReason: 'end_turn' });
  await until(() => !c.busy, 'done');
});
