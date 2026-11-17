/**
 * Inbox v3.1 phase 2, the agent connection's stall facts (server/acp/connection.ts attention(), inbox-rules.js stallOf), with the
 * fake agent:
 *   S1 died        the agent exits mid-turn: stalled 'died' with its last step; closing the chat yourself or a Stop never is;
 *   S2 silent_end  the turn ends right after a tool call with no final words: stalled 'silent_end'; a turn that ends with words
 *                  is not; sending again clears it;
 *   S3 quiet       a running turn with no output for the quiet time (shortened here) and nothing running: stalled 'quiet'; the
 *                  row leaves the moment the agent prints again.
 * Each makes a Needs-you row (rowsOf) with Continue first, and Mark handled clears it.
 */
import { assert, assertEquals } from './_assert.ts';
import { events, Lab, until } from './_connection.ts';
import type { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { INBOX } from '../../outputs/agent-studio/server/attention/inbox_rules.ts';

Deno.env.set('AGENT_STUDIO_TEST', '1');
Deno.env.set('AIB_TEST_QUIET_SECONDS', '2');
const LONG = 60;
const turnEnds = (c: Connection) => events(c, 'turn_end').length;
const row = (c: Connection, mark: unknown = {}) =>
  INBOX.rowOf({ key: 'claude:s', id: c.id, live: !c.closed, attention: c.attention(), mark, title: 'Chat', project: { key: 'p', name: 'shop' } }, Date.now() / 1000);

Deno.test('stalled S1: the agent exits mid-turn: died, with its last step; closing the chat yourself is never a stall', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--held-turn']);
  await c.prompt('die:npm test', 'm1');
  await until(() => c.closed, 'the agent died', LONG);
  const a = c.attention();
  assertEquals(a.stallKind, 'died');
  assertEquals(a.stallStep, 'npm test');
  assert(INBOX.secondsOf(a.stalledAt) > 0);
  const r = row(c);
  assertEquals(r?.kind, 'stalled');
  assertEquals(r?.section, 'needs');
  assertEquals(r?.what, 'Stopped mid-work: the agent quit during npm test');
  assertEquals(r?.actions.map((x) => x.id).slice(0, 3), ['continue', 'reply', 'handled']);
  assertEquals(row(c, { handledAt: Date.now() / 1000 + 1 }), null, 'Mark handled clears it');

  const quiet = await lab.open(['--held-turn']);
  await quiet.prompt('quiet:' + lab.path('never'), 'q1');
  await until(() => events(quiet, 'update').length > 0, 'the turn runs', LONG);
  await quiet.close(); // AIB (you) closed it: not a stall
  assertEquals(quiet.attention().stallKind, undefined);
  assertEquals(row(quiet), null);
});

Deno.test('stalled S2: a turn that ends right after a tool call with no final words; words at the end or sending again clear it', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--held-turn']);
  await c.prompt('silent:Edit src/cart.ts', 'm1');
  await until(() => !c.busy && turnEnds(c) === 1, 'the silent end', LONG);
  const a = c.attention();
  assertEquals(a.stallKind, 'silent_end');
  assertEquals(a.stallStep, 'Edit src/cart.ts');
  assertEquals(INBOX.phaseOf(a, {}, Date.now() / 1000), 'stalled');
  assertEquals(row(c)?.what, 'Stopped without a final message, after Edit src/cart.ts');
  await c.prompt('hello', 'm2'); // sending clears it; this reply has words
  await until(() => !c.busy && turnEnds(c) === 2, 'the next reply', LONG);
  assertEquals(c.attention().stallKind, undefined);
  assertEquals(c.attention().phase, 'idle');
});

Deno.test('stalled S3: a running turn quiet for the quiet time with nothing running; output makes it leave at once', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--held-turn']);
  const gate = lab.path('wake');
  await c.prompt('quiet:' + gate, 'm1');
  await until(() => c.busy && events(c, 'update').length > 0, 'the turn runs', LONG);
  assert(c.attention().stallKind === undefined, 'not quiet yet');
  await until(() => c.attention().stallKind === 'quiet', 'gone quiet', LONG);
  const a = c.attention();
  assertEquals(INBOX.phaseOf(a, {}, Date.now() / 1000), 'stalled');
  assertEquals(row(c)?.what, 'No output for 20 minutes, last: Read server/main.ts');
  Deno.writeTextFileSync(gate, 'go'); // the agent prints again: the row leaves
  await until(() => !c.busy && turnEnds(c) === 1, 'the turn ended with words', LONG);
  assertEquals(c.attention().stallKind, undefined);
  assertEquals(row(c), null);
});
