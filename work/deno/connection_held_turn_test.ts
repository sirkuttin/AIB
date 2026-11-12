/**
 * server/acp/connection.ts: Claude Code's held turns. claude-agent-acp holds a prompt's response open while background helpers the
 * turn started still run; AIB ends the turn when the reply ends (the result's usage_update, `_claude/origin` human) and shows the
 * cycle Claude Code starts on its own when a helper finishes as working until that cycle's result. fake_acp.py --held-turn replays
 * the update shapes a real run of the adapter sent; 'helper:<gate>' lets its helper finish when the test creates <gate>, and the
 * follow-up cycle end when it creates <gate>.end.
 */
import { assert, assertEquals } from './_assert.ts';
import { events, type Json, Lab, pause, until, updateTexts } from './_connection.ts';
import type { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';

const LONG = 60; // a deadline, not a delay

class HeldLab extends Lab {
  #gates = 0;
  gate(): string {
    return this.path(`gate-${this.#gates++}`);
  }
  open_(path: string): void {
    Deno.writeTextFileSync(path, 'go');
  }
}

const texts = (c: Connection) => c.events.filter((e) => e.kind === 'user').map((e) => (e.data as Json).text);
const turnEnds = (c: Connection) => events(c, 'turn_end').map((e) => (e.data as Json).stopReason);
const helperState = (c: Connection) => c.subagents.get('helper-1')?.state;

Deno.test('held turn: the reply ends while a background helper runs: not working, and the queued message goes at once', async () => {
  await using lab = new HeldLab();
  const c = await lab.open(['--held-turn']);
  const gate = lab.gate();
  await c.prompt(`helper:${gate}`, 'm1');
  assert(c.busy);
  assert((await c.queueAdd('next', 'q1')).queued); // written while the agent works
  await until(() => texts(c).length === 2, 'the queued message sent', LONG);
  assertEquals(texts(c), [`helper:${gate}`, 'next']);
  await until(() => updateTexts(c).includes('Fixture reply: next') && !c.busy, 'the second reply', LONG);
  assertEquals(turnEnds(c), ['end_turn', 'end_turn']);
  assertEquals(c.promptReceipts.get('m1')?.state, 'finished');
  assertEquals(helperState(c), 'running'); // the helper still shows as running
  assertEquals(c.attention().state, 'idle');
  assertEquals(c.queuePublic().items, []);
  lab.open_(gate);
  lab.open_(gate + '.end');
  await until(() => helperState(c) === 'idle' && turnEnds(c).length === 3 && !c.busy, 'the follow-up ended', LONG);
});

Deno.test("held turn: the helper's updates and its permission request reach the idle chat; answering lets the queue go on", async () => {
  await using lab = new HeldLab();
  const c = await lab.open(['--held-turn']);
  const gate = lab.gate();
  await c.prompt(`helper-ask:${gate}`);
  await until(() => !c.busy && turnEnds(c).length === 1, 'the turn ended', LONG);
  lab.open_(gate);
  await until(() => c.permissions.size === 1, "the helper's permission request", LONG);
  assert(updateTexts(c).includes('helper at work'));
  const helperUpdate = events(c, 'update').find((e) => ((e.data as Json).update as Json).content &&
    (((e.data as Json).update as Json).content as Json).text === 'helper at work')!;
  assertEquals((helperUpdate.data as Json).sessionId, 'helper-1');
  const [key, ask] = [...c.permissions][0];
  assertEquals(get(ask.params, 'sessionId'), 'helper-1');
  assertEquals(c.attention().state, 'needs_you');
  assert(events(c, 'permission').length === 1);
  await c.queueAdd('after', 'q1'); // must not go before the answer
  await pause(200);
  assertEquals(texts(c), [`helper-ask:${gate}`]); // waits for the answer
  c.permission(key, 'yes');
  await until(() => texts(c).length === 2, 'the queued message sent after the answer', LONG);
  await until(() => updateTexts(c).includes('Fixture reply: after') && !c.busy, 'its reply', LONG);
  await until(() => updateTexts(c).includes('helper approved'), 'the helper went on', LONG);
  lab.open_(gate + '.end');
  await until(() => helperState(c) === 'idle' && !c.busy && !c.autonomous, 'all done', LONG);
});

Deno.test("held turn: Claude Code's own follow-up inside the held turn shows as working until its result", async () => {
  await using lab = new HeldLab();
  const c = await lab.open(['--held-turn']);
  const gate = lab.gate();
  await c.prompt(`helper:${gate}`);
  await until(() => !c.busy && turnEnds(c).length === 1, 'the turn ended', LONG);
  assertEquals(c.attention().busySince, null);
  lab.open_(gate);
  await until(() => updateTexts(c).includes('Helper finished.'), 'the follow-up', LONG);
  assert(c.busy && c.autonomous);
  assertEquals(c.attention().state, 'working');
  assert(c.attention().busySince);
  assertEquals(c.public().state, 'working');
  assert((await c.queueAdd('later', 'q1')).queued); // queued while it works, like any turn
  lab.open_(gate + '.end');
  await until(() => texts(c).length === 2, 'the queued message sent when the follow-up ended', LONG);
  await until(() => !c.busy && updateTexts(c).includes('Fixture reply: later'), 'its reply', LONG);
  assertEquals(turnEnds(c), ['end_turn', 'end_turn', 'end_turn']); // the turn, the follow-up, the queued message; the held response adds none
  await pause(200);
  assertEquals(turnEnds(c).length, 3);
  assert(!c.autonomous);
});

Deno.test('held turn: a follow-up after the next prompt took the held turn over is shown as working too, with no response', async () => {
  await using lab = new HeldLab();
  const c = await lab.open(['--held-turn']);
  const gate = lab.gate();
  await c.prompt(`helper:${gate}`);
  await until(() => !c.busy, 'the turn ended', LONG);
  await c.prompt('hi');
  await until(() => !c.busy && updateTexts(c).includes('Fixture reply: hi'), 'the second turn', LONG);
  assertEquals(c.pending.size, 0); // the held response came when the next prompt arrived
  lab.open_(gate);
  await until(() => c.busy && c.autonomous, 'the follow-up working', LONG);
  lab.open_(gate + '.end');
  await until(() => !c.busy, 'the follow-up ended', LONG);
  assertEquals(turnEnds(c), ['end_turn', 'end_turn', 'end_turn']);
});

Deno.test("held turn: a prompt sent while Claude Code's own cycle runs takes it over; stopping the cycle ends working", async () => {
  await using lab = new HeldLab();
  const c = await lab.open(['--held-turn']);
  const [g1, g2] = [lab.gate(), lab.gate()];
  await c.prompt(`helper:${g1}`);
  await until(() => !c.busy, 'the turn ended', LONG);
  lab.open_(g1);
  await until(() => c.autonomous, 'the follow-up working', LONG);
  await c.prompt('take over'); // the page saw it idle a moment ago
  assert(c.busy && !c.autonomous);
  await until(() => !c.busy && updateTexts(c).includes('Fixture reply: take over'), 'its reply', LONG);
  lab.open_(g1 + '.end');
  await c.prompt(`helper:${g2}`);
  await until(() => !c.busy, 'the second helper turn ended', LONG);
  lab.open_(g2);
  await until(() => c.autonomous, 'the second follow-up working', LONG);
  const before = turnEnds(c).length;
  c.cancel();
  assert(!c.autonomous);
  await until(() => !c.busy, 'idle after the stop', LONG);
  assertEquals(turnEnds(c).slice(before), ['cancelled']);
  lab.open_(g2 + '.end');
  await pause(200);
  assert(!c.busy); // the stopped cycle's late result changes nothing
});

Deno.test('held turn: another agent with the same stream is unchanged: busy until the response', async () => {
  await using lab = new HeldLab();
  const c = await lab.open(['--held-turn', '--not-claude']);
  const gate = lab.gate();
  await c.prompt(`helper:${gate}`);
  await until(() => updateTexts(c).includes('Started a helper.'), 'the reply', LONG);
  await pause(300);
  assert(c.busy);
  assertEquals(turnEnds(c), []);
  lab.open_(gate);
  await until(() => updateTexts(c).includes('Helper finished.'), 'the follow-up', LONG);
  assert(c.busy && !c.autonomous);
  lab.open_(gate + '.end');
  await until(() => !c.busy, 'the response', LONG);
  assertEquals(turnEnds(c), ['end_turn']);
  assert(!c.autonomous);
});

Deno.test('held turn: a Claude turn whose helpers all finished before its result ends with its response as before', async () => {
  await using lab = new HeldLab();
  const c = await lab.open(['--held-turn']);
  await c.prompt('plain');
  await until(() => !c.busy, 'the reply', LONG);
  assertEquals(turnEnds(c), ['end_turn']);
  assertEquals(c.pending.size, 0);
  assert(!c.autonomous);
});

function get(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Json)[key] : undefined;
}
