/**
 * Send later (owner, 2026-11-23): a message set to go out at a time. The host owns the schedule (Connection.scheduleAdd and friends;
 * server/acp/msgqueue.ts keeps it with the queue in the same store file), so it fires with the window closed, behind a running turn,
 * never cancelling it, and a time missed while AIB was off goes at the next start with a "Sent late" line in the chat. Fake agent only.
 * The page side is work/test_send_later.js; a chat in a WSL project is work/deno/wsl_send_later_e2e_test.ts (real distro, skipped here).
 */
import { assert, assertEquals } from './_assert.ts';
import { events, Lab, type Json, pause, rejectsValue, until } from './_connection.ts';
import { fake } from './_connection.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { QueueStore } from '../../app/server/acp/msgqueue.ts';
import { LIVE_POST_OPS, Aib } from '../../app/server/host/aib.ts';
import { Recovery, StateStore } from '../../app/server/state/recovery.ts';

const LONG = 60; // a deadline, not a delay

class SendLab extends Lab {
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
const scheduled = (c: Connection) => (c.queuePublic().scheduled ?? []) as Json[];
const queued = (c: Connection) => (c.queuePublic().items as Json[]).map((i) => i.id);
const idle = (c: Connection) => until(() => !c.busy && !c.queue.inflight, 'idle', LONG);
const MIN = 60_000;

/** A fake clock: c.scheduleNow reads `clock.now`; move it to move time. */
function clockOf(c: Connection, start = Date.now()) {
  const clock = { now: start };
  c.scheduleNow = () => clock.now;
  return clock;
}
async function busyTurn(c: Connection, text: string) {
  await c.prompt(text);
  await until(() => c.busy, 'busy turn', LONG);
}
function attach(c: Connection, stateDir: string): Recovery {
  const recovery = new Recovery(new StateStore(stateDir, 'recovery-t'));
  recovery.queues = new QueueStore(stateDir, 'queues-t');
  c.recovery = recovery;
  return recovery;
}

Deno.test('send later: a scheduled message waits, shows its time, and sends nothing before then', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  const at = clock.now + 30 * MIN;
  const answer = await c.scheduleAdd('mcp', at, 's1');
  assertEquals([answer.ok, answer.id, answer.at], [true, 's1', at]);
  const card = scheduled(c);
  assertEquals(card.map((i) => [i.id, i.text, i.at]), [['s1', 'mcp', at]]);
  assertEquals(queued(c), [], 'not in the queue yet: it does not pause or block anything');
  assertEquals(c.queuePublic().reason, '');
  clock.now += 29 * MIN;
  await c.scheduleTick();
  await pause(150);
  assertEquals(texts(c), []);
  assertEquals(scheduled(c).length, 1);
});

Deno.test('send later: it fires at the time, as a normal send', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  await c.scheduleAdd('mcp', clock.now + 30 * MIN, 's1');
  clock.now += 30 * MIN;
  await c.scheduleTick();
  await until(() => texts(c).join() === 'mcp', 'sent at its time', LONG);
  await idle(c);
  assertEquals(scheduled(c), []);
  assertEquals(events(c, 'user').map((e) => (e.data as Json).clientMessageId), ['s1']);
  assertEquals(events(c, 'studio_note').filter((e) => String((e.data as Json).message).startsWith('Sent late')), [], 'on time: no late note');
});

Deno.test('send later: the host timer fires it by itself (no page, no call)', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  await c.scheduleAdd('mcp', Date.now() + 600, 't1');
  assertEquals(texts(c), []);
  await until(() => texts(c).join() === 'mcp', 'the timer sent it', LONG);
  assertEquals(scheduled(c), []);
});

Deno.test('send later: behind a running turn it waits in the queue and never cancels the turn', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  const g = lab.gate();
  await busyTurn(c, g);
  await c.scheduleAdd('mcp', clock.now + MIN, 's1');
  clock.now += 2 * MIN;
  await c.scheduleTick();
  assert(c.busy, 'the running turn is still running');
  assertEquals(queued(c), ['s1'], 'now an ordinary queued message');
  assertEquals(scheduled(c), []);
  assertEquals(texts(c), [g]);
  await pause(200);
  assert(c.busy);
  lab.release(g);
  await until(() => texts(c).length === 2, 'sent when the turn ended', LONG);
  await idle(c);
  assertEquals(texts(c), [g, 'mcp']);
  assertEquals(events(c, 'turn_end').filter((e) => JSON.stringify(e.data).includes('cancelled')), [], 'nothing was cancelled');
});

Deno.test('send later: edit the text and the time', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  await c.scheduleAdd('sleep:0.3', clock.now + 10 * MIN, 's1');
  await c.scheduleAdd('sleep:0.1', clock.now + 20 * MIN, 's2');
  await c.scheduleEdit('s1', 'sleep:0.2', clock.now + 40 * MIN);
  assertEquals(scheduled(c).map((i) => [i.id, i.text]), [['s2', 'sleep:0.1'], ['s1', 'sleep:0.2']], 'kept in time order');
  assertEquals(scheduled(c)[1].at, clock.now + 40 * MIN);
  await rejectsValue(() => c.scheduleEdit('s1', null, clock.now - 10 * MIN)); // already passed
  await rejectsValue(() => c.scheduleEdit('nope', 'x', null));
  await rejectsValue(() => c.scheduleEdit('s1', '   ', null)); // the same checks as any message
  clock.now += 45 * MIN;
  await c.scheduleTick();
  await until(() => texts(c).includes('sleep:0.2') && texts(c).includes('sleep:0.1'), 'both went, edited text', LONG);
  assert(!texts(c).includes('sleep:0.3'));
});

Deno.test('send later: cancel removes it and it is never sent', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  await c.scheduleAdd('never mind', clock.now + MIN, 's1');
  await c.scheduleCancel('s1');
  assertEquals(scheduled(c), []);
  await rejectsValue(() => c.scheduleCancel('s1'));
  clock.now += 5 * MIN;
  await c.scheduleTick();
  await pause(200);
  assertEquals(texts(c), []);
});

Deno.test('send later: send now goes at once, the card goes, nothing else changes', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  await c.scheduleAdd('mcp', clock.now + 3 * 60 * MIN, 's1');
  await c.scheduleAdd('still later', clock.now + 4 * 60 * MIN, 's2');
  await c.scheduleSendNow('s1');
  await until(() => texts(c).join() === 'mcp', 'sent now', LONG);
  assertEquals(scheduled(c).map((i) => i.id), ['s2']);
  await rejectsValue(() => c.scheduleSendNow('s1'));
});

Deno.test('send later: refuses a past time, no time, and a time more than a year away', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  await rejectsValue(() => c.scheduleAdd('late', clock.now - 10 * MIN));
  await rejectsValue(() => c.scheduleAdd('no time', null));
  await rejectsValue(() => c.scheduleAdd('far', clock.now + 400 * 86_400_000));
  await rejectsValue(() => c.scheduleAdd('   ', clock.now + MIN));
  assertEquals(scheduled(c), []);
  await c.scheduleAdd('once', clock.now + MIN, 'dup');
  assert((await c.scheduleAdd('once', clock.now + MIN, 'dup')).duplicate, 'a retry of the same id never schedules twice');
  await rejectsValue(() => c.scheduleAdd('different', clock.now + MIN, 'dup'));
  assertEquals(scheduled(c).length, 1);
});

Deno.test('send later: the schedule survives a restart (same store file as the queue) and still fires', async () => {
  await using lab = new SendLab();
  const stateDir = lab.path('state');
  const c = await lab.open();
  const recovery = attach(c, stateDir);
  recovery.connectionReady(c);
  const t0 = Date.now();
  const clock = clockOf(c, t0);
  await c.scheduleAdd('mcp', t0 + 30 * MIN, 's1');
  Deno.statSync(lab.path('state/studio-queues-t.json'));
  assertEquals(recovery.queues!.get(c.provider, c.sessionId!).length, 1);
  void clock;
  const d = await lab.open(); // a new host: same state dir, same conversation
  const dClock = clockOf(d, t0 + MIN);
  const recovery2 = attach(d, stateDir);
  recovery2.connectionReady(d);
  assertEquals(scheduled(d).map((i) => [i.id, i.text, i.at]), [['s1', 'mcp', t0 + 30 * MIN]]);
  assertEquals(d.queuePublic().reason, '', 'a schedule alone never pauses the queue');
  await pause(200);
  assertEquals(texts(d), [], 'not yet');
  dClock.now = t0 + 31 * MIN;
  await d.scheduleTick();
  await until(() => texts(d).join() === 'mcp', 'fired after the restart', LONG);
  assertEquals(events(d, 'studio_note').filter((e) => String((e.data as Json).message).startsWith('Sent late')), [], '1 minute early is on time');
  await idle(d);
  await until(() => !recovery2.queues!.get(d.provider, d.sessionId!).length, 'a sent message leaves the file', LONG);
});

Deno.test('send later: a time missed while AIB was off sends at the next start, marked "Sent late (scheduled …)"', async () => {
  await using lab = new SendLab();
  const stateDir = lab.path('state');
  const c = await lab.open();
  const recovery = attach(c, stateDir);
  recovery.connectionReady(c);
  const t0 = Date.now();
  clockOf(c, t0);
  await c.scheduleAdd('mcp', t0 + 5 * MIN, 's1');
  const d = await lab.open();
  clockOf(d, t0 + 3 * 60 * MIN); // AIB comes back three hours later
  const recovery2 = attach(d, stateDir);
  recovery2.connectionReady(d);
  await until(() => texts(d).join() === 'mcp', 'sent on the next start', LONG);
  const note = events(d, 'studio_note').map((e) => String((e.data as Json).message)).find((m) => m.startsWith('Sent late'));
  assert(note && /^Sent late \(scheduled .+\)$/.test(note), `the chat says so: ${note}`);
  const stamp = new Date(t0 + 5 * MIN).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  assertEquals(note, `Sent late (scheduled ${stamp})`);
  const order = d.events.map((e) => e.kind).filter((k) => k === 'user' || k === 'studio_note');
  assertEquals(order.slice(0, 2), ['user', 'studio_note'], 'the line sits right under the message');
  await idle(d);
  assertEquals(scheduled(d), []);
});

Deno.test('send later: a missed time with a message already waiting in the paused queue goes in behind it and shows as queued', async () => {
  await using lab = new SendLab();
  const stateDir = lab.path('state');
  const c = await lab.open();
  const recovery = attach(c, stateDir);
  recovery.connectionReady(c);
  const t0 = Date.now();
  clockOf(c, t0);
  const g = lab.gate();
  await busyTurn(c, g);
  await c.queueAdd('sleep:0.1', 'q1');
  await c.scheduleAdd('sleep:0.2', t0 + MIN, 's1');
  const d = await lab.open();
  clockOf(d, t0 + 10 * MIN);
  const recovery2 = attach(d, stateDir);
  recovery2.connectionReady(d);
  await until(() => queued(d).join() === 'q1,s1', 'both wait, in order', LONG);
  assertEquals(d.queuePublic().reason, 'restart', 'the restart pause covers what was queued; Resume sends them in order');
  await d.queueResume();
  await until(() => texts(d).length === 2, 'both sent, one per turn', LONG);
  assertEquals(texts(d)[0], 'sleep:0.1');
  lab.release(g);
});

Deno.test('send later: AIB routes schedule, schedule-edit, schedule-send-now and schedule-cancel', async () => {
  assert(['schedule', 'schedule-edit', 'schedule-cancel', 'schedule-send-now'].every((op) => LIVE_POST_OPS.has(op)));
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-later-studio-' }));
  const state = dir + (Deno.build.os === 'windows' ? '\\' : '/') + 'state';
  const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true });
  aib.ownerProbe = () => null;
  aib.connectionFactory = (_command, cwd, provider) => new Connection(fake(), cwd, provider);
  try {
    const c = await aib.connect('claude', dir);
    const at = Date.now() + 3_600_000;
    const [status, body] = await aib.liveCall('schedule', { id: c.id, text: 'via route', clientMessageId: 'r1', at });
    assertEquals([status, (body as Json).ok], [200, true]);
    assertEquals(scheduled(c).map((i) => [i.id, i.at]), [['r1', at]]);
    assertEquals((await aib.liveCall('schedule-edit', { id: c.id, messageId: 'r1', text: 'mcp', at: at + MIN }))[0], 200);
    assertEquals(scheduled(c).map((i) => [i.text, i.at]), [['mcp', at + MIN]]);
    assertEquals((await aib.liveCall('schedule', { id: c.id, text: 'cancel me', clientMessageId: 'r2', at }))[0], 200);
    assertEquals((await aib.liveCall('schedule-cancel', { id: c.id, messageId: 'r2' }))[0], 200);
    assertEquals(scheduled(c).map((i) => i.id), ['r1']);
    assertEquals((await aib.liveCall('schedule-send-now', { id: c.id, messageId: 'r1' }))[0], 200);
    await until(() => texts(c).join() === 'mcp', 'sent now', LONG);
    assertEquals(scheduled(c), []);
  } finally {
    await aib.close().catch(() => {});
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(dir, { recursive: true });
        break;
      } catch {
        await pause(200);
      }
    }
  }
});

Deno.test('send later: the up-arrow on a scheduled card never cancels a busy non-steering agent; the message goes first after the turn', async () => {
  await using lab = new SendLab();
  const c = await lab.open();
  const clock = clockOf(c);
  const g = lab.gate();
  await busyTurn(c, g);
  assert(!c.steerable(), 'the fake agent cannot steer');
  await c.queueAdd('mcp', 'q1');
  await c.scheduleAdd('mcp', clock.now + 3 * 60 * MIN, 's1');
  await c.scheduleSendNow('s1');
  await pause(300);
  assert(c.busy && !c.interrupted, 'the running turn was not cancelled');
  assertEquals(queued(c), ['s1', 'q1'], 'it moved to the front of the after-turn queue');
  assertEquals(scheduled(c), []);
  assertEquals(texts(c), [g]);
  lab.release(g);
  await until(() => texts(c).length === 3, 'sent after the turn, in order', LONG);
  assertEquals(events(c, 'user').map((e) => (e.data as Json).clientMessageId), [null, 's1', 'q1']);
  assertEquals(events(c, 'turn_end').filter((e) => JSON.stringify(e.data).includes('cancelled')), [], 'nothing was cancelled');
});

// ---- a chat nobody opened: the host scans the saved schedules --------------------------------------------------------------
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
function tempDir(): string {
  return Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-later-scan-' }));
}
function aibAt(dir: string, factory?: () => Connection): Aib {
  const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: dir + SEP + 'state', port: 0, ownersDir: null, noArtifactTool: true });
  aib.ownerProbe = () => null;
  aib.connectionFactory = factory ? () => factory() : (_command, cwd, provider) => new Connection(fake(), cwd, provider);
  return aib;
}
async function cleanup(dir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      Deno.removeSync(dir, { recursive: true });
      return;
    } catch {
      await pause(200);
    }
  }
}
/** A previous AIB run: one chat with a message scheduled `inMs` from now; it ends with the chat closed (saved, not open). */
async function previousRunWithSchedule(dir: string, inMs: number): Promise<string> {
  const first = aibAt(dir);
  const c = await first.connect('claude', dir);
  await c.scheduleAdd('mcp', Date.now() + inMs, 's1');
  const path = first.recovery!.queues!.path;
  await first.close();
  return path;
}
function moveScheduleBack(path: string, ms: number): void {
  const file = JSON.parse(Deno.readTextFileSync(path));
  for (const items of Object.values(file.sessions) as Json[][]) for (const i of items) if (i.lane === 'scheduled') i.at = (i.at as number) - ms;
  Deno.writeTextFileSync(path, JSON.stringify(file));
}
const opened = (s: Aib) => [...s.connections.values()].filter((c) => !c.closed);

Deno.test('send later: a time missed while AIB was off goes at the next start even when nobody opens the chat', async () => {
  const dir = tempDir();
  try {
    const path = await previousRunWithSchedule(dir, 5 * MIN);
    moveScheduleBack(path, 3 * 60 * MIN);
    const second = aibAt(dir);
    assertEquals(opened(second), [], 'nothing is open');
    second.startScheduleScan();
    await until(() => opened(second).some((c) => texts(c).join() === 'mcp'), 'sent without anyone opening the chat', LONG);
    const c = opened(second)[0];
    const note = events(c, 'studio_note').map((e) => String((e.data as Json).message)).find((m) => m.startsWith('Sent late'));
    assert(note && /^Sent late \(scheduled .+\)$/.test(note), `the chat says so: ${note}`);
    await idle(c);
    assertEquals(scheduled(c), []);
    await second.close();
  } finally {
    await cleanup(dir);
  }
});

Deno.test('send later: a future schedule in an unopened chat fires at its time, not before', async () => {
  const dir = tempDir();
  try {
    await previousRunWithSchedule(dir, 2500);
    const second = aibAt(dir);
    second.startScheduleScan();
    await pause(500);
    assertEquals(opened(second), [], 'not opened before its time');
    await until(() => opened(second).some((c) => texts(c).join() === 'mcp'), 'fired at its time', LONG);
    const c = opened(second)[0];
    assertEquals(events(c, 'studio_note').filter((e) => String((e.data as Json).message).startsWith('Sent late')), [], 'on time, not late');
    await second.close();
  } finally {
    await cleanup(dir);
  }
});

Deno.test('send later: a chat that cannot be reopened keeps the scheduled card with a plain error line', async () => {
  const dir = tempDir();
  try {
    const path = await previousRunWithSchedule(dir, 5 * MIN);
    moveScheduleBack(path, 3 * 60 * MIN);
    const second = aibAt(dir, () => {
      throw new Error('the agent is not installed');
    });
    await second.scheduleScan();
    assertEquals(opened(second), []);
    const saved = new QueueStore(dir + SEP + 'state', 'queues-0').get('claude', 'fake-session');
    assertEquals(saved.length, 1, 'the message is not lost');
    assert(String(saved[0].error).includes('could not reopen'), String(saved[0].error));
    // later the agent is back: opening the chat sends it
    const third = aibAt(dir);
    const c = await third.connect('claude', dir, 'fake-session');
    await until(() => texts(c).join() === 'mcp', 'sent once the chat opens', LONG);
    await third.close();
  } finally {
    await cleanup(dir);
  }
});
