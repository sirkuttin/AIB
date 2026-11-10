/**
 * server/acp/connection.ts: queued messages (work/test_queue.py), settings queued during a turn (test_pending_settings.py),
 * receipts across a restart (the Connection side of test_runtime.py and test_unknown_receipts.py), session discovery and
 * subagent cancellation (test_runtime.py). Fake agent only; a 'gate:<file>' turn ends when the test creates the file.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { events, fake, type Json, Lab, pause, rejectsValue, until } from './_connection.ts';
import type { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { currentValue } from '../../outputs/agent-studio/server/acp/breadth.ts';
import { QueueStore } from '../../outputs/agent-studio/server/acp/msgqueue.ts';
import { PromptStateUnknown } from '../../outputs/agent-studio/server/acp/rpc_errors.ts';
import { Recovery, StateStore } from '../../outputs/agent-studio/server/state/recovery.ts';
import { ValueError } from '../../outputs/agent-studio/server/core/py.ts';
import { createHash } from 'node:crypto';

const LONG = 60; // a deadline, not a delay: generous so a loaded machine still passes

class QueueLab extends Lab {
  gates: string[] = [];
  gate(): string {
    const path = this.path(`gate-${this.gates.length}`);
    this.gates.push(path);
    return `gate:${path}`;
  }
  release(gate: string): void {
    Deno.writeTextFileSync(gate.slice(5), 'go');
  }
}

const texts = (c: Connection) => c.events.filter((e) => e.kind === 'user').map((e) => (e.data as Json).text);
const ids = (c: Connection) => (c.queuePublic().items as Json[]).map((i) => i.id);
const idle = (c: Connection) => until(() => !c.busy && !c.queue.inflight, 'idle', LONG);
async function settle(c: Connection, quiet = 100) {
  await idle(c);
  await pause(quiet);
}
async function busyTurn(c: Connection, text: string) {
  await c.prompt(text);
  await until(() => c.busy, 'busy turn', LONG);
}

// ---- test_queue.py QueueTests -----------------------------------------------------------------------------------------------

Deno.test('queue: a message queued while busy is sent after the turn ends', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  const g = lab.gate();
  await busyTurn(c, g);
  assert((await c.queueAdd('mcp', 'q1')).queued);
  assertEquals(texts(c), [g]);
  lab.release(g);
  await until(() => JSON.stringify(texts(c)) === JSON.stringify([g, 'mcp']), 'queued message sent', LONG);
  await idle(c);
  assertEquals(c.queuePublic().items, []);
});

Deno.test('queue: a message queued while idle is sent at once', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  assert(!(await c.queueAdd('mcp', 'q1')).queued);
  await until(() => texts(c).join() === 'mcp');
});

Deno.test('queue: one message per turn, in order', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  const [g1, g2] = [lab.gate(), lab.gate()];
  await busyTurn(c, g1);
  await c.queueAdd(g2, 'a');
  await c.queueAdd('mcp', 'b');
  await c.queueAdd('mcp', 'c');
  lab.release(g1);
  await until(() => texts(c).length === 2, 'second turn started', LONG);
  assertEquals(ids(c), ['b', 'c']); // only one went out
  lab.release(g2);
  await until(() => texts(c).length === 4, 'all sent', LONG);
  await idle(c);
  assertEquals(events(c, 'user').map((e) => (e.data as Json).clientMessageId), [null, 'a', 'b', 'c']);
});

Deno.test('queue: a duplicate enqueue never sends twice', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  const g = lab.gate();
  await busyTurn(c, g);
  await c.queueAdd('mcp', 'dup');
  assert((await c.queueAdd('mcp', 'dup')).duplicate);
  assertEquals(ids(c), ['dup']);
  lab.release(g);
  await until(() => texts(c).length === 2, 'sent', LONG);
  await idle(c);
  const late = await c.queueAdd('mcp', 'dup'); // after it was sent: the prompt receipt answers
  assertEquals([late.duplicate, late.queued], [true, false]);
  await settle(c);
  assertEquals(texts(c), [g, 'mcp']);
  await rejectsValue(() => c.queueAdd('different', 'dup'));
});

Deno.test('queue: an edit lease pauses the queue for as long as it is open', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  const g = lab.gate();
  await busyTurn(c, g);
  await c.queueAdd('mcp', 'a');
  await c.queueAdd('mcp', 'b');
  const lease = (await c.queueEdit('a', 'acquire')).leaseId as string;
  assertEquals([c.queuePublic().reason, c.queuePublic().message], ['editing', 'Paused while you edit']);
  lab.release(g);
  await settle(c); // the turn is over; the open edit keeps the queue paused
  assert(!c.busy);
  assertEquals(texts(c), [g]);
  await c.queueEdit('a', 'renew', lease);
  await c.queueEdit('a', 'save', lease, 'sleep:0.1');
  await until(() => texts(c)[1] === 'sleep:0.1', 'saved edit sent when the queue resumed', LONG);
  await until(() => texts(c).length === 3, 'b follows', LONG);
});

Deno.test('queue: cancelling the edit resumes and sends the original', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  const g = lab.gate();
  await busyTurn(c, g);
  await c.queueAdd('mcp', 'a');
  const lease = (await c.queueEdit('a', 'acquire')).leaseId as string;
  lab.release(g);
  await settle(c);
  assertEquals(texts(c), [g]);
  await c.queueEdit('a', 'cancel', lease);
  await until(() => texts(c)[1] === 'mcp', 'original sent', LONG);
});

Deno.test('queue: editing a later message does not block earlier ones but pauses at it', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  const [g1, g2] = [lab.gate(), lab.gate()];
  await busyTurn(c, g1);
  await c.queueAdd(g2, 'a');
  await c.queueAdd('mcp', 'b');
  const lease = (await c.queueEdit('b', 'acquire')).leaseId as string;
  assertEquals(c.queuePublic().reason, ''); // a is first and free
  lab.release(g1);
  await until(() => texts(c)[1] === g2, 'a sent', LONG);
  lab.release(g2);
  await settle(c);
  assertEquals(ids(c), ['b']); // b is now next up and is being edited: paused
  assertEquals(c.queuePublic().reason, 'editing');
  assertEquals(texts(c).length, 2);
  await c.queueEdit('b', 'cancel', lease);
  await until(() => texts(c).length === 3, 'b sent', LONG);
});

Deno.test('queue: an expired lease keeps the queue paused and never auto-sends', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  let clock = 1000;
  c.queue.clock = () => clock;
  const g = lab.gate();
  await busyTurn(c, g);
  await c.queueAdd('mcp', 'a');
  await c.queueEdit('a', 'acquire');
  clock += c.queue.leaseSeconds + 1; // the lease expires while the turn runs; the page vanished
  lab.release(g);
  await settle(c);
  const state = c.queuePublic();
  assertEquals(state.reason, 'abandoned');
  assert((state.message as string).includes('was being edited'));
  assertEquals(texts(c), [g]);
  await c.queueAdd('mcp', 'b'); // new messages wait behind it
  await settle(c);
  assertEquals(ids(c), ['a', 'b']);
  await c.queueResume();
  await until(() => texts(c).length === 2, 'sent after the user resumed', LONG);
});

Deno.test('queue: an expired lease can be removed', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  let clock = 1000;
  c.queue.clock = () => clock;
  const g = lab.gate();
  await busyTurn(c, g);
  await c.queueAdd('mcp', 'a');
  await c.queueAdd('mcp', 'b');
  await c.queueEdit('a', 'acquire');
  clock += c.queue.leaseSeconds + 1;
  lab.release(g);
  await settle(c);
  await c.queueRemove('a');
  await until(() => texts(c)[1] === 'mcp', 'b sent', LONG);
  await idle(c);
  assertEquals(c.queuePublic().items, []);
});

Deno.test('queue: a second editor cannot take an active lease', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  await busyTurn(c, 'wait');
  await c.queueAdd('mcp', 'a');
  await c.queueEdit('a', 'acquire', 'one');
  await rejectsValue(() => c.queueEdit('a', 'acquire', 'two'));
  await rejectsValue(() => c.queueEdit('a', 'renew', 'two'));
  await rejectsValue(() => c.queueSendNow('a')); // not while its editor is open
});

Deno.test('queue: needs-you pauses the queue', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  const g = lab.gate();
  const prompt = 'leave-open:' + g.slice(5); // ends its turn when released, with a question and an approval still pending
  await busyTurn(c, prompt);
  await c.queueAdd('mcp', 'a');
  lab.release(g);
  await settle(c);
  assertEquals(c.queuePublic().reason, 'needs_you');
  assertEquals(ids(c), ['a']);
  assertEquals(texts(c), [prompt]);
  await c.queueResume();
  await until(() => texts(c)[1] === 'mcp', 'sent after resume', LONG);
});

Deno.test('queue: interrupting pauses the queue', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  await busyTurn(c, 'wait');
  await c.queueAdd('mcp', 'a');
  c.cancel();
  await settle(c);
  assertEquals(c.queuePublic().reason, 'interrupted');
  assertEquals(texts(c), ['wait']);
});

Deno.test('queue: send-now interrupts and sends that item first', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  await busyTurn(c, 'wait');
  await c.queueAdd('mcp', 'a');
  await c.queueAdd('mcp', 'b');
  await c.queueSendNow('b');
  await until(() => texts(c)[1] === 'mcp', 'b sent', LONG);
  await until(() => texts(c).length === 3, 'a follows', LONG);
  assertEquals(events(c, 'user').map((e) => (e.data as Json).clientMessageId), [null, 'b', 'a']);
});

Deno.test('queue: remove and reorder', async () => {
  await using lab = new QueueLab();
  const c = await lab.open();
  await busyTurn(c, 'wait');
  for (const name of 'abc') await c.queueAdd('mcp', name);
  await c.queueMove('c', 0);
  assertEquals(ids(c), ['c', 'a', 'b']);
  await c.queueRemove('a');
  assertEquals(ids(c), ['c', 'b']);
  await rejectsValue(() => c.queueRemove('a'));
  assertEquals(((c.public().queue as Json).items as Json[])[0].id, 'c');
});

Deno.test('queue: attachments are validated when queued', async () => {
  await using lab = new QueueLab();
  const c = await lab.open(); // no --images: the agent takes no pictures
  await busyTurn(c, 'wait');
  await rejectsValue(() => c.queueAdd('look', 'img', [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]));
  assertEquals(ids(c), []);
});

// ---- test_queue.py QueuePersistenceTests --------------------------------------------------------------------------------------

function attach(c: Connection, stateDir: string): Recovery {
  const recovery = new Recovery(new StateStore(stateDir, 'recovery-t'));
  recovery.queues = new QueueStore(stateDir, 'queues-t');
  c.recovery = recovery;
  return recovery;
}

Deno.test('queue persistence: the queue survives a host restart paused and is sent once on resume', async () => {
  await using lab = new QueueLab();
  const stateDir = lab.path('state');
  const c = await lab.open();
  const recovery = attach(c, stateDir);
  recovery.connectionReady(c);
  await busyTurn(c, 'wait');
  await c.queueAdd('mcp', 'a');
  await c.queueAdd('mcp', 'b');
  Deno.statSync(lab.path('state/studio-queues-t.json'));
  const d = await lab.open(); // a new host: same state dir, same conversation
  const recovery2 = attach(d, stateDir);
  recovery2.connectionReady(d);
  const state = d.queuePublic();
  assertEquals([(state.items as Json[]).map((i) => i.id), state.reason], [['a', 'b'], 'restart']);
  await settle(d);
  assertEquals(texts(d), []); // nothing is sent without the user
  await d.queueResume();
  await until(() => texts(d).length === 2, 'both sent, one per turn', LONG);
  await idle(d);
  await until(() => !recovery2.queues!.get(d.provider, d.sessionId!).length, 'sent items leave the saved file', LONG);
});

Deno.test('queue persistence: sent items leave the file and ending the chat forgets the queue', async () => {
  await using lab = new QueueLab();
  const stateDir = lab.path('state');
  const c = await lab.open();
  const recovery = attach(c, stateDir);
  recovery.connectionReady(c);
  await busyTurn(c, 'wait');
  await c.queueAdd('mcp', 'a');
  assertEquals(recovery.queues!.get(c.provider, c.sessionId!).length, 1);
  await c.queueRemove('a');
  assertEquals(recovery.queues!.get(c.provider, c.sessionId!), []);
  await c.queueAdd('mcp', 'b');
  await c.close();
  assertEquals(recovery.queues!.get(c.provider, c.sessionId!), []);
});

Deno.test('queue persistence: an item whose delivery is unknown after a restart is held, not resent', async () => {
  await using lab = new QueueLab();
  const stateDir = lab.path('state');
  const c = await lab.open();
  const recovery = attach(c, stateDir);
  recovery.connectionReady(c);
  // the host died while 'a' was being handed to the agent: its receipt says unknown, the queue file still lists it
  const item = { id: 'a', text: 'mcp', attachments: [], fingerprint: 'x', queuedAt: Date.now() / 1000 };
  recovery.store.setReceipt(c.provider, c.sessionId!, 'a', createHash('sha256').update('mcp').digest('hex'), 'unknown');
  recovery.queues!.put(c.provider, c.sessionId!, [item]);
  const d = await lab.open();
  const recovery2 = attach(d, stateDir);
  recovery2.connectionReady(d);
  await d.queueResume();
  await settle(d);
  assertEquals(texts(d), []);
  assertEquals(d.queuePublic().reason, 'unknown');
  assertEquals(ids(d), ['a']);
});

// ---- test_pending_settings.py QueueTests ------------------------------------------------------------------------------------

async function openLogged(lab: Lab, ...flags: string[]): Promise<Connection & { sent: [string, unknown][] }> {
  const c = await lab.open(['--breadth', ...flags]) as Connection & { sent: [string, unknown][] };
  c.sent = [];
  const original = c.request.bind(c);
  c.request = (method, params, timeout = 30) => {
    const p = params as Json;
    c.sent.push([method, p.configId || p.modeId || null]);
    return original(method, params, timeout);
  };
  return c;
}
const endTurn = async (c: Connection) => (c.cancel(), await until(() => !c.busy, 'turn end', LONG));
const model = (c: Connection) => currentValue(c.settings, 'config', 'model');
const keys = (c: Connection) => (c.public().pendingChanges as Json[]).map((p) => p.key);

Deno.test('settings: a change during a turn is queued, then applied when it ends', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  await busyTurn(c, 'wait');
  assert((await c.changeSetting('config', 'model', 'deep')).queued);
  assertEquals(keys(c), ['config:model']);
  assertEquals((c.public().pendingChanges as Json[])[0].value, 'deep');
  assertEquals(model(c), 'fast', 'the agent is not asked while its turn runs');
  assert(!c.sent.some(([m]) => m === 'session/set_config_option'));
  await endTurn(c);
  assertEquals(model(c), 'deep');
  assertEquals([c.public().pendingChanges, c.public().changeFailures], [[], []]);
  assertEquals(c.sent.filter(([m]) => m === 'session/set_config_option').length, 1);
});

Deno.test('settings: applied in the order chosen; the last choice per setting wins', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  await busyTurn(c, 'wait');
  await c.changeSetting('config', 'model', 'deep');
  await c.changeSetting('config', 'effort', 'high');
  await c.changeSetting('config', 'verbose', true);
  await c.changeSetting('config', 'model', 'fast'); // back to the current value: nothing left to apply
  await c.changeSetting('config', 'model', 'deep'); // chosen again: now last in order
  assertEquals(keys(c), ['config:effort', 'config:verbose', 'config:model']);
  await c.changeSetting('config', 'effort', 'low'); // equals the current value: withdrawn
  assertEquals(keys(c), ['config:verbose', 'config:model']);
  await endTurn(c);
  assertEquals(c.sent.filter(([m]) => m === 'session/set_config_option').map(([, i]) => i), ['verbose', 'model']);
  assertEquals([model(c), currentValue(c.settings, 'config', 'verbose')], ['deep', true]);
});

Deno.test('settings: the mode is queued too, and validated', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  await busyTurn(c, 'wait');
  await assertRejects(() => c.changeSetting('mode', null, 'no-such-mode'), ValueError);
  assertEquals((await c.changeSetting('mode', null, 'code')).queued, false, 'already the current mode');
  assertEquals(c.public().pendingChanges, []);
  await endTurn(c);
});

Deno.test('settings: cancelPending removes it and nothing is applied', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  await busyTurn(c, 'wait');
  await c.changeSetting('config', 'model', 'deep');
  assertEquals(c.cancelPending('config:model'), []);
  let refused = false;
  try {
    c.cancelPending('config:model');
  } catch (error) {
    refused = error instanceof ValueError;
  }
  assert(refused);
  await endTurn(c);
  assertEquals(model(c), 'fast');
  assert(!c.sent.some(([m]) => m === 'session/set_config_option'));
});

Deno.test('settings: validation happens when queuing, not at turn end', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  await busyTurn(c, 'wait');
  for (const bad of [['config', 'model', 'gigantic'], ['config', 'nope', 'x'], ['config', 'verbose', 'yes'], ['bogus', 'model', 'deep']]) {
    await assertRejects(() => c.changeSetting(bad[0], bad[1], bad[2]), ValueError);
  }
  assertEquals(c.public().pendingChanges, []);
  await endTurn(c);
});

Deno.test('settings: idle changes still apply immediately', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  assert(!(await c.changeSetting('config', 'model', 'deep')).queued);
  assertEquals(model(c), 'deep');
  await assertRejects(() => c.changeSetting('config', 'model', 'gigantic'), ValueError);
});

Deno.test('settings: a refused change is reported, the value stays, and the prompt still works', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab, '--reject-config');
  await busyTurn(c, 'wait');
  await c.changeSetting('config', 'model', 'deep');
  await endTurn(c);
  await until(
    () => !(c.public().pendingChanges as Json[]).length && (c.public().changeFailures as Json[]).length === 1,
    'the refusal',
    LONG,
  );
  const failure = (c.public().changeFailures as Json[])[0];
  assertEquals([failure.key, failure.value], ['config:model', 'deep']);
  assert((failure.message as string).includes('Fixture refuses this setting'));
  assertEquals(model(c), 'fast');
  assert((await c.prompt('/compact', 'm-after')).accepted, 'the user can keep working');
  await until(() => !c.busy, 'next turn', LONG);
});

Deno.test('settings: leftovers apply before a new prompt is sent; a failure never drops the prompt', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  const leftover = () => ({ key: 'config:model', kind: 'config', configId: 'model', value: 'deep', queuedAt: Date.now() / 1000 });
  c.pendingChanges.set('config:model', leftover()); // a change still queued although the turn has ended
  await c.prompt('/compact', 'm1');
  await until(() => !c.busy, 'turn', LONG);
  const order = c.sent.map(([m]) => m);
  assert(order.indexOf('session/set_config_option') < order.indexOf('session/prompt'));
  assertEquals(model(c), 'deep');
  const broken = await openLogged(lab, '--reject-config');
  broken.pendingChanges.set('config:model', leftover());
  assert((await broken.prompt('/compact', 'm2')).accepted);
  await until(() => !broken.busy, 'turn', LONG);
  assert(broken.sent.some(([m]) => m === 'session/prompt'));
  assertEquals((broken.public().changeFailures as Json[]).length, 1);
  assert(events(broken, 'user').some((e) => (e.data as Json).text === '/compact'));
});

Deno.test('settings: busy clears only after the queued changes were applied', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab);
  await busyTurn(c, 'wait');
  await c.changeSetting('config', 'effort', 'high');
  c.cancel();
  const deadline = Date.now() + LONG * 1000;
  while (Date.now() < deadline && c.busy) await pause(5);
  assertEquals(currentValue(c.settings, 'config', 'effort'), 'high', 'busy only clears after the queue was applied');
});

Deno.test('settings: the failures list is bounded', async () => {
  await using lab = new Lab();
  const c = await openLogged(lab, '--reject-config');
  for (let index = 0; index < 8; index++) {
    await busyTurn(c, 'wait');
    await c.changeSetting('config', index % 2 ? 'verbose' : 'effort', index % 2 ? true : 'high');
    await endTurn(c);
  }
  const failures = c.public().changeFailures as Json[];
  assertEquals([failures.length, failures.at(-1)!.seq], [5, 8]);
});

// ---- receipts across a restart (test_runtime.py RecoveryTests, test_unknown_receipts.py: the Connection side) -----------------

/** What Studio does around a Connection on start and orderly shutdown, without the Studio. */
async function hostRun(lab: Lab, stateDir: string, resume: string | null = null): Promise<[Connection, Recovery]> {
  const c = lab.connection(fake());
  const recovery = new Recovery(new StateStore(stateDir, 'recovery-h'));
  c.recovery = recovery;
  await c.setup(resume);
  recovery.connectionReady(c);
  return [c, recovery];
}

async function shutdown(c: Connection, recovery: Recovery): Promise<void> {
  recovery.shuttingDown = true; // orderly host shutdown keeps the entry so the next start can offer reconnecting
  await c.close();
}

Deno.test('receipts: a restart never replays an unconfirmed prompt, and the page sees the unknown receipt', async () => {
  await using lab = new Lab();
  const stateDir = lab.path('state');
  const [first, recovery] = await hostRun(lab, stateDir);
  await first.prompt('wait', 'attempt-1');
  await until(() => first.busy);
  await shutdown(first, recovery); // while the turn is still working
  const [again] = await hostRun(lab, stateDir, 'fake-session');
  assertEquals(events(again, 'user').length, 0, 'reconnecting must not send anything');
  assertEquals((again.public().unknownReceipts as Json[]).map((u) => u.clientMessageId), ['attempt-1']);
  await assertRejects(() => again.prompt('wait', 'attempt-1'), PromptStateUnknown);
  await assertRejects(() => again.prompt('different text', 'attempt-1'), ValueError);
  assertEquals(events(again, 'user').length, 0);
  const accepted = await again.prompt('wait', 'attempt-2'); // "Send again" uses a new id and gets its own receipt
  assert(!accepted.duplicate);
  assertEquals(again.recovery!.store!.unknownReceipts('omp', 'fake-session').length, 1);
  again.cancel();
  await until(() => !again.busy);
});

Deno.test('receipts: a finished receipt dedupes after a restart', async () => {
  await using lab = new Lab();
  const stateDir = lab.path('state');
  const [first, recovery] = await hostRun(lab, stateDir);
  await first.prompt('hello', 'attempt-done');
  await until(() => first.permissions.size);
  first.permission(first.permissions.keys().next().value!, 'yes');
  await until(() => !first.busy);
  await shutdown(first, recovery);
  const [again, recovery2] = await hostRun(lab, stateDir, 'fake-session');
  const result = await again.prompt('hello', 'attempt-done');
  assertEquals([result.duplicate, result.turnState], [true, 'finished']);
  assertEquals(events(again, 'user').length, 0);
  await again.close(); // explicit user disconnect forgets the conversation
  assertEquals(recovery2.store.conversations.size, 0);
});

// ---- test_runtime.py: discovery and subagents ----------------------------------------------------------------------------------

Deno.test('discovery: session/list paginates; agents without it report unsupported', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--list-sessions'], { setup: false });
  await c.initializeForDiscovery();
  const page = await c.listSessions();
  assert(page.supported);
  assertEquals((page.sessions as Json[]).map((s) => s.sessionId), ['agent-listed-1', 'agent-listed-2']);
  const later = await c.listSessions(null, page.nextCursor as string);
  assertEquals([(later.sessions as Json[]).map((s) => s.sessionId), later.nextCursor], [['agent-listed-3'], null]);
  const plain = await lab.open([], { setup: false });
  await plain.initializeForDiscovery();
  assertEquals(await plain.listSessions(), { supported: false, sessions: [], nextCursor: null });
});

Deno.test('subagents: cancel only when advertised, and not once it stopped', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--subagent']);
  await c.prompt('delegate');
  await until(() => 'child-1' in (c.public().subagents as Json));
  const child = (c.public().subagents as Record<string, Json>)['child-1'];
  assertEquals(child.title, 'Review the fixture');
  assert('cancel' in (child.capabilities as Json));
  let error: unknown = null;
  try {
    c.cancelSubagent('unknown-child');
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ValueError);
  c.cancel('child-1');
  await until(() => (c.public().subagents as Record<string, Json>)['child-1'].state === 'idle');
  error = null;
  try {
    c.cancelSubagent('child-1'); // no longer running
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ValueError);
  c.cancel();
  await until(() => !c.busy);
});

Deno.test('subagents: without a cancel capability a child is read-only', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  c.subagents.set('child-x', { capabilities: {}, state: 'running' });
  let message = '';
  try {
    c.cancelSubagent('child-x');
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes('did not advertise'), message);
});
