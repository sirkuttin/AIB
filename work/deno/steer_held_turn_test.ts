/**
 * T15 (B1): Claude Code holds a prompt's response while helpers the turn started run; AIB ends the turn early when the reply ends
 * (the result's usage_update, origin human). A steer interrupts the running cycle, which then sends a result of its own, and the
 * steered message's reply comes after it, in the same cycle or in one of its own (recording C4: two human results in one prompt).
 * Neither may end the turn early, or the page shows Your turn, the queue sends, and a second turn_end follows.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { SteerLab, turnEnds, userEvents } from './_steer.ts';
import { steerTiming } from '../../outputs/agent-studio/server/acp/connection.ts';

steerTiming.settleMs = 400;

Deno.test("T15 (B1): with a helper running, a steer's interrupted cycle and its own cycle never end the turn early twice", async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('claude');
  await c.prompt('start the helper', 'm1');
  const prompt = await p.take('session/prompt');
  await p.update({ sessionUpdate: 'subagent_update', sessionId: 'helper-1', title: 'Explore', state: 'running' });
  await p.text('Started a helper.');
  const sending = c.steer('quick question', 's1');
  await p.reply((await p.take('_session/steering')).id, { outcome: 'injected' });
  await sending;
  await p.result('human'); // the interrupted cycle's own result: nothing was said after the steer
  await pause(800);
  assert(c.busy, 'not ended by the interrupted cycle');
  await p.text('Done.'); // the first cycle's last words (after the steer)
  await p.result('human');
  await pause(100);
  await p.text('10'); // the steer's own cycle starts before the settle time is over (recording C4)
  await pause(800);
  assert(c.busy, 'not ended while the steer was still being answered');
  assertEquals(turnEnds(c), []);
  await p.result('human');
  await until(() => !c.busy, 'ended early once the reply settled', 5);
  assertEquals(turnEnds(c), ['end_turn']);
  assertEquals(c.promptReceipts.get('m1')?.state, 'finished');
  await p.reply(prompt.id, { stopReason: 'end_turn' }); // the held response, once the helper is done
  await pause(300);
  assertEquals(turnEnds(c), ['end_turn'], 'one turn end, not two');
  assert(!c.busy && !c.autonomous);
  assertEquals(userEvents(c).map((u) => u.text), ['start the helper', 'quick question']);
});

Deno.test('T15: without a steer the held turn still ends at its result at once (the beta.8 behaviour)', async () => {
  await using lab = new SteerLab();
  const { c, p } = await lab.chat('claude');
  await c.prompt('start the helper', 'm1');
  const prompt = await p.take('session/prompt');
  await p.update({ sessionUpdate: 'subagent_update', sessionId: 'helper-1', title: 'Explore', state: 'running' });
  await p.text('Started a helper.');
  await p.result('human');
  await until(() => !c.busy, 'ended at once', 2);
  await p.reply(prompt.id, { stopReason: 'end_turn' });
  await pause(200);
  assertEquals(turnEnds(c), ['end_turn']);
});
