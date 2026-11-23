/**
 * An agent may refuse a prompt while it still works (OMP did, other agents can): "Agent is already processing. Use steer() or followUp()...". AIB never shows that
 * to the owner: Send now (and a plain Send) during a running turn delivers the message, and nothing running is cancelled.
 * The agent end is a Puppet playing a plain agent (_steer.ts).
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { promptText, SteerLab, turnEnds, userEvents } from './_steer.ts';
import { busyRetry, isAgentBusyError } from '../../outputs/agent-studio/server/acp/connection.ts';

const BUSY = 'Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.';
const errors = (c: { events: Record<string, unknown>[] }) => c.events.filter((e) => e.kind === 'error');

Deno.test("isAgentBusyError matches an agent's busy refusal only", () => {
  assert(isAgentBusyError(new Error(BUSY)));
  assert(!isAgentBusyError(new Error('rate limited')));
});

Deno.test('Send now during a running turn: the busy refusal is retried, no error, nothing cancelled, the message arrives', async () => {
  const saved = { ...busyRetry };
  busyRetry.delayMs = 50;
  try {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('plain');
    await c.prompt('go', 'm1');
    const first = await p.take('session/prompt');
    // The agent answers the steer "promptRequired": its adapter does not see a running turn, yet its agent is still processing.
    const sending = c.steer('side question', 's1');
    const steer = await p.take('_session/steering');
    await p.reply(steer.id, { outcome: 'promptRequired', reason: 'noRunningTurn' });
    assertEquals((await sending).state, 'fallback');
    // the running work ends; the message goes as a prompt, the agent says busy twice, then takes it
    await p.reply(first.id, { stopReason: 'end_turn' });
    const second = await p.take('session/prompt');
    assertEquals(promptText(second), 'side question');
    await p.replyError(second.id, BUSY);
    const again = await p.take('session/prompt');
    await p.replyError(again.id, BUSY);
    const third = await p.take('session/prompt');
    assertEquals(promptText(third), 'side question');
    assertEquals(c.error, '');
    assertEquals(errors(c).length, 0, 'the raw refusal is never shown');
    assert(c.busy, 'still working while it waits');
    await p.reply(third.id, { stopReason: 'end_turn' });
    await until(() => !c.busy && turnEnds(c).length === 2, 'the second turn ended');
    assertEquals(c.error, '');
    assertEquals(errors(c).length, 0);
    assertEquals(p.all('session/cancel').length, 0, 'nothing was cancelled');
    assertEquals(userEvents(c).map((u) => u.text), ['go', 'side question']);
    assertEquals(c.promptReceipts.get('s1')?.state, 'finished');
  } finally {
    Object.assign(busyRetry, saved);
  }
});

Deno.test('Plain Send while busy queues for the turn end like other agents; a busy refusal then retries without an error', async () => {
  const saved = { ...busyRetry };
  busyRetry.delayMs = 50;
  try {
    await using lab = new SteerLab();
    const { c, p } = await lab.chat('plain');
    await c.prompt('go', 'm1');
    const first = await p.take('session/prompt');
    await c.queueAdd('after', 'q1');
    assertEquals((c.queuePublic().items as unknown[]).length, 1);
    assertEquals(p.all('session/prompt').length, 1, 'not sent into the running turn');
    await p.reply(first.id, { stopReason: 'end_turn' });
    const second = await p.take('session/prompt');
    await p.replyError(second.id, BUSY);
    const third = await p.take('session/prompt');
    assertEquals(promptText(third), 'after');
    await p.reply(third.id, { stopReason: 'end_turn' });
    await until(() => !c.busy && turnEnds(c).length === 2, 'the queued turn ended');
    assertEquals(errors(c).length, 0);
    assertEquals(c.error, '');
    assertEquals((c.queuePublic().items as unknown[]).length, 0);
  } finally {
    Object.assign(busyRetry, saved);
  }
});
