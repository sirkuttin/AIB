/**
 * server/host/studio.ts, the connection manager (test_studio.py's manager tests, the in-process half of test_auto_reconnect.py, and
 * the Connection-through-Studio parts of test_attention.py, test_breadth.py and test_attachments.py). Fake ACP agent only, temp
 * state folders.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection, ThreadEvent } from '../../outputs/agent-studio/server/acp/connection.ts';
import { reconnectKey, Studio, type StudioOptions } from '../../outputs/agent-studio/server/host/studio.ts';
import { OwnershipConflict, SessionLease } from '../../outputs/agent-studio/server/ownership/ownership.ts';
import { OwnershipEvidence } from '../../outputs/agent-studio/server/ownership/probe.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-studio-test-' }));
  readonly state = this.dir + (Deno.build.os === 'windows' ? '\\' : '/') + 'state';
  readonly studios: Studio[] = [];

  manager(flags: string[] = [], options: Partial<StudioOptions> = {}): Studio {
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ...options });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider) => new Connection(fake(...flags), cwd, provider);
    this.studios.push(studio);
    return studio;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

/** Just enough of a Connection for the lease tests (Python used a Mock). */
class FakeConnection {
  id: string;
  provider = 'omp';
  closed = false;
  ready: boolean;
  sessionId: string | null = null;
  sessionLease: { release(): void } | null = null;
  caps = {};
  openDone = new ThreadEvent();
  worktree = null;
  error = '';
  setupHook: (resume: string | null) => Promise<void> | void = () => {};
  constructor(id: string, ready = true) {
    this.id = id;
    this.ready = ready;
  }
  async setup(resume: string | null) {
    this.sessionId = resume;
    await this.setupHook(resume);
  }
  close() {
    this.sessionLease?.release();
    this.closed = true;
    return Promise.resolve();
  }
  public() {
    return { id: this.id };
  }
}

Deno.test({
  name: 'manager: a resumed chat is opened once, a second Studio is refused by the lease, an external owner by its PID',
  ...T,
  async fn() {
    await using lab = new Lab();
    const manager = lab.manager();
    let made = 0;
    const conn = new FakeConnection('owned-connection');
    manager.connectionFactory = () => (made++, conn as never);
    const first = await manager.connect('omp', lab.dir, 'saved-session');
    assert(await manager.connect('omp', lab.dir, 'saved-session') === first);
    assertEquals(made, 1);
    const other = lab.manager();
    await assertRejects(() => other.connect('omp', lab.dir, 'saved-session'), OwnershipConflict);
    await manager.close();
    const external = lab.manager();
    external.ownerProbe = () => 999;
    let called = 0;
    external.connectionFactory = () => (called++, conn as never);
    const error = await assertRejects(() => external.connect('omp', lab.dir, 'saved-session'), OwnershipConflict);
    assert(error.message.includes('PID 999'), error.message);
    assertEquals(called, 0);
    (await new SessionLease(lab.state, 'omp', 'saved-session').acquire()).release(); // the refused connect released its lease
  },
});

Deno.test({
  name: 'manager: a second request for a chat that is still opening is refused',
  ...T,
  async fn() {
    await using lab = new Lab();
    const manager = lab.manager();
    const started = new ThreadEvent();
    const release = new ThreadEvent();
    const conn = new FakeConnection('opening-connection', false);
    conn.setupHook = async () => {
      started.set();
      await release.wait(3000);
      conn.ready = true;
    };
    manager.connectionFactory = () => conn as never;
    const opening = manager.connect('omp', lab.dir, 'opening-session');
    assert(await started.wait(2000));
    const error = await assertRejects(() => manager.connect('omp', lab.dir, 'opening-session'), OwnershipConflict);
    assert(error.message.includes('already opening'), error.message);
    release.set();
    await opening;
  },
});

Deno.test({
  name: 'manager: a background connect returns while a setup question waits, and finishes after the answer',
  ...T,
  async fn() {
    await using lab = new Lab();
    const manager = lab.manager(['--setup-question']);
    const connection = await manager.connect('omp', lab.dir, null, { background: true });
    await until(() => connection.elicitations.size > 0, 'setup question');
    assert(!connection.ready);
    assertEquals(connection.public().state, 'input_needed');
    connection.answerElicitation([...connection.elicitations.keys()][0], 'accept', { label: 'Example workspace' });
    await until(() => connection.ready, 'ready');
    assert(await connection.openDone.wait(3000));
    assertEquals(connection.sessionId, 'fake-session');
    assert(connection.public().ready);
  },
});

Deno.test({
  name: 'manager: a background setup failure closes the connection and releases the resume lease',
  ...T,
  async fn() {
    await using lab = new Lab();
    const manager = lab.manager(['--setup-question', '--setup-fail']);
    const connection = await manager.connect('omp', lab.dir, 'resume-during-setup', { background: true });
    await until(() => connection.elicitations.size > 0, 'setup question');
    connection.answerElicitation([...connection.elicitations.keys()][0], 'accept', { label: 'Failure fixture' });
    await until(() => connection.closed, 'closed');
    assert(await connection.openDone.wait(3000));
    assert(connection.error.includes('Fixture setup failure'), connection.error);
    (await new SessionLease(lab.state, 'omp', 'resume-during-setup').acquire()).release();
  },
});

Deno.test({
  name: 'manager: a duplicate background resume is refused until setup finishes; cancelling sign-in releases the lease',
  ...T,
  async fn() {
    await using lab = new Lab();
    const manager = lab.manager(['--setup-question']);
    const first = await manager.connect('omp', lab.dir, 'same-resume', { background: true });
    await until(() => first.elicitations.size > 0, 'setup question');
    const error = await assertRejects(() => manager.connect('omp', lab.dir, 'same-resume', { background: true }), OwnershipConflict);
    assert(error.message.includes('already opening'));
    first.answerElicitation([...first.elicitations.keys()][0], 'accept', { label: 'Resume' });
    await until(() => first.ready, 'ready');

    const auth = lab.manager(['--auth-required']);
    const connection = await auth.connect('omp', lab.dir, 'auth-lease', { background: true });
    await until(() => connection.auth !== null, 'sign-in prompt');
    connection.answerAuth('cancel');
    await until(() => connection.closed, 'closed');
    assert(connection.error.includes('Sign-in was cancelled'), connection.error);
    (await new SessionLease(lab.state, 'omp', 'auth-lease').acquire()).release();
  },
});

// ---- automatic reconnect (test_auto_reconnect.py, in-process half) -----------------------------------------------------------
async function previousRun(lab: Lab): Promise<void> {
  const first = lab.manager();
  await first.connect('omp', lab.dir);
  await first.close();
}

const live = (s: Studio) => [...s.connections.values()].filter((c) => !c.closed && c.ready);

Deno.test({
  name: 'auto-reconnect: a chat that was live reconnects without sending anything',
  ...T,
  async fn() {
    await using lab = new Lab();
    await previousRun(lab);
    const second = lab.manager();
    assertEquals(second.recovered().length, 1);
    assertEquals(second.startAutoReconnect(2, 0, null, 0), 1);
    await until(() => live(second).length, 'reconnected chat');
    await until(() => second.recovered().length === 0 && second.reconnectPending.size === 0, 'recovery list cleared');
    const connection = live(second)[0];
    assertEquals([connection.provider, connection.sessionId], ['omp', 'fake-session']);
    assertEquals((connection.public().events as Json[]).filter((e) => e.kind === 'user'), [], 'reconnecting must not send anything');
    assert(!connection.busy);
    const listed = await second.liveList();
    assert(listed.autoReconnect);
    assertEquals((listed.connections as Json[])[0].reconnecting, false);
  },
});

Deno.test({
  name: 'auto-reconnect: the reconnecting flag shows while queued; owned or possibly active chats are skipped',
  ...T,
  async fn() {
    await using lab = new Lab();
    await previousRun(lab);
    const second = lab.manager();
    second.reconnectPending.add(reconnectKey('omp', 'fake-session'));
    assert(second.recovered()[0].reconnecting);
    assert(((await second.liveList()).recovered as Json[])[0].reconnecting);
    second.reconnectPending.clear();
    assert(!second.recovered()[0].reconnecting);

    second.ownerProbe = () => 4242; // another agent process has the session open
    second.startAutoReconnect(2, 0, null, 0);
    await until(() => second.reconnectPending.size === 0, 'attempt finished');
    assertEquals(live(second), []);
    assertEquals(second.recovered().length, 1, 'still listed as a saved chat that is not running');

    const third = lab.manager();
    const calls: boolean[] = [];
    third.checkOwnership = (_p, _s, _c, continueAnyway = false) => {
      calls.push(continueAnyway);
      throw new OwnershipEvidence('Another app may be using this conversation.', 'possibly_active', {});
    };
    third.startAutoReconnect(2, 0, null, 0);
    await until(() => third.reconnectPending.size === 0, 'attempt finished');
    assertEquals(calls, [false], 'continueAnyway is never set');
    assertEquals(live(third), []);
    assertEquals(third.recovered().length, 1);
  },
});

Deno.test({
  name: 'auto-reconnect: failures retry, then drop from the recovery list; a failure that clears up still reconnects',
  ...T,
  async fn() {
    await using lab = new Lab();
    await previousRun(lab);
    const second = lab.manager();
    const attempts: unknown[] = [];
    second.connect = (_p, _c, _r, options) => {
      attempts.push(options?.continueAnyway);
      return Promise.reject(Object.assign(new Error('agent failed to load the conversation'), { name: 'RuntimeError' }));
    };
    second.startAutoReconnect(2, 0, 3, 0);
    await until(() => second.reconnectPending.size === 0, 'attempts finished');
    assertEquals(second.recovered(), []);
    assertEquals(second.store!.conversations.size, 0, 'dropped from the durable list');
    assertEquals(attempts, [false, false, false], 'three tries, ownership check never bypassed');
    assertEquals(lab.manager().recovered(), []);

    await previousRun(lab);
    const flaky = lab.manager();
    const real = flaky.connect.bind(flaky);
    let tries = 0;
    flaky.connect = (...args) => (++tries === 1 ? Promise.reject(new Error('agent not ready yet')) : real(...args));
    flaky.startAutoReconnect(2, 0, null, 0);
    await until(() => live(flaky).length, 'reconnected after a retry');
    assertEquals(tries, 2);
  },
});

Deno.test({
  name: 'auto-reconnect: off by flag; nothing without a state folder; two at a time, staggered',
  ...T,
  async fn() {
    await using lab = new Lab();
    await previousRun(lab);
    const off = lab.manager([], { autoReconnect: false });
    assertEquals(off.startAutoReconnect(2, 0), 0);
    await pause(200);
    assertEquals(off.connections.size, 0);
    assertEquals(off.recovered().length, 1);
    assertEquals((await off.liveList()).autoReconnect, false);

    const bare = new Studio({ ompCommand: 'unused' });
    assertEquals(bare.startAutoReconnect(), 0);
    await bare.close();

    const first = lab.manager();
    for (let n = 0; n < 4; n++) {
      const folder = `${lab.dir}/w${n}`;
      Deno.mkdirSync(folder);
      first.store!.rememberConversation('omp', `session-${n}`, folder);
    }
    await first.close();
    const second = lab.manager();
    let active = 0, peak = 0;
    const starts: number[] = [];
    second.connect = async () => {
      active++;
      peak = Math.max(peak, active);
      starts.push(Date.now());
      await pause(300);
      active--;
      return null as never;
    };
    assertEquals(second.startAutoReconnect(2, 0.1, null, 0), 5); // the earlier test chat is still listed too
    await until(() => second.reconnectPending.size === 0, 'all attempted');
    assertEquals(peak, 2);
    assertEquals(starts.length, 5);
    const sorted = [...starts].sort((a, b) => a - b);
    assert(sorted.slice(1).every((b, i) => b - sorted[i] >= 90), JSON.stringify(sorted));
  },
});

// ---- the live operations through the Studio (attention, breadth, attachments) -------------------------------------------------
Deno.test({
  name: 'liveCall: attention in the list, config and session ops, attachments, and Python error texts',
  ...T,
  async fn() {
    await using lab = new Lab();
    const manager = lab.manager(['--breadth', '--embedded-context', '--subagent']);
    const c = await manager.connect('omp', lab.dir);
    const listed = await manager.liveList();
    const entry = (listed.connections as Json[]).find((x) => x.id === c.id)!;
    assertEquals(Object.keys(entry.attention as Json).sort(), ['busySince', 'needs', 'state', 'turnEndedAt']);
    assertEquals((entry.attention as Json).busySince, null);
    assertEquals((entry.attention as Json).state, 'idle');
    assert(!('events' in entry) && !('permissions' in entry));

    assertEquals((await manager.liveCall('config', { id: c.id, configId: 'verbose', value: true, type: 'boolean' }))[0], 200);
    assert(((c.settings.configOptions as Json[]).find((o) => o.id === 'verbose')!).currentValue === true);
    assertEquals((await manager.liveCall('config', { id: c.id, configId: 'dial', value: 1 }))[0], 400);
    const [status, page] = await manager.liveCall('session-op', { id: c.id, op: 'list' }) as [number, Json];
    assertEquals([status, page.nextCursor, (page.sessions as Json[])[0].title], [200, 'page2', 'First <b>']);
    for (const body of [{ op: 'delete' }, { op: 'delete', confirm: 'delete:other' }, { op: 'fork' }]) {
      assertEquals((await manager.liveCall('session-op', { ...body, id: c.id }))[0], 400, JSON.stringify(body));
    }

    // A file attachment reaches the agent through a prompt; a refused one is a 400 and nothing is sent.
    const file = { type: 'file', name: 'n.md', mimeType: 'text/markdown', data: btoa('# hi') };
    const [sent, result] = await manager.liveCall('prompt', { id: c.id, text: 'read', clientMessageId: 'm1', attachments: [file] }) as [
      number,
      Json,
    ];
    assertEquals([sent, result.ok, result.duplicate], [200, true, false]);
    await until(() => !c.busy, 'turn end');
    const [again, retry] = await manager.liveCall('prompt', { id: c.id, text: 'read', clientMessageId: 'm1', attachments: [file] }) as [
      number,
      Json,
    ];
    assertEquals([again, retry.duplicate], [200, true]);
    const [changed, refusal] = await manager.liveCall('prompt', { id: c.id, text: 'other', clientMessageId: 'm1' }) as [number, Json];
    assertEquals(changed, 400);
    assert(String(refusal.error).includes('different text'));

    // A subagent's permission makes the chat need you; it counts in busy.
    await manager.liveCall('prompt', { id: c.id, text: 'child-ask', clientMessageId: 'm2' });
    await until(() => c.permissions.size > 0, 'permission');
    assertEquals(c.attention().state, 'needs_you');
    assertEquals(manager.busyList().map((b) => b.state), ['needs_you']);
    const key = [...c.permissions.keys()][0];
    assertEquals((await manager.liveCall('permission', { id: c.id, key, option: 'nope' }))[0], 400);
    assertEquals((await manager.liveCall('cancel', { id: c.id }))[0], 200);
    await until(() => !c.busy, 'cancelled');

    // Python's messages for missing keys and unknown things.
    assertEquals(await manager.liveCall('prompt', { id: 'nope' }), [400, { error: "'nope'" }]);
    assertEquals(await manager.liveCall('permission', {}), [400, { error: "'id'" }]);
    assertEquals(await manager.liveCall('nonsense', {}), [404, { error: 'Not found' }]);
    assertEquals(await manager.liveCall('connect', []), [400, { error: 'Invalid request' }]);
    assertEquals(await manager.liveCall('connect', { provider: 'omp', cwd: lab.dir, background: 'yes' }), [400, {
      error: 'background must be a boolean',
    }]);
    assertEquals(await manager.liveCall('dismiss-unknown', {}), [400, { error: 'provider, sessionId and clientMessageId are required' }]);
    assertEquals(await manager.liveCall('forget', { provider: 'omp', sessionId: 'never' }), [200, { ok: true, forgotten: false }]);

    // The internal worktree note: only Studio's two buttons, clipped labels.
    await manager.liveCall('worktree-note', {
      id: c.id,
      message: 'Merged',
      actions: [{ id: 'keep-mine', label: 'Keep mine' }, { id: 'rm -rf', label: 'x' }],
    });
    const note = (c.public().events as Json[]).filter((e) => e.kind === 'studio_note').pop()!;
    assertEquals(note.data, { message: 'Merged', sessionId: 'fake-session', actions: [{ id: 'keep-mine', label: 'Keep mine' }] });
    assertEquals(await manager.emitArtifact(c.id, { type: 'artifact' }), true);
    assertEquals(await manager.emitArtifact('nope', {}), false);
    assertEquals(await manager.liveState('nope'), null);

    // Disconnect: closed, still listed for a while, then evicted.
    assertEquals(await manager.liveCall('disconnect', { id: c.id }), [200, { ok: true }]);
    assert(c.closed);
    assertEquals((await manager.liveInfo()).connections, []);
    assertEquals(manager.evictClosed(manager.clock() + 11 * 60), [c.id]);
    assertEquals(manager.connections.size, 0);
  },
});

Deno.test({
  name: 'ownershipQuery: hints without a chat, a refused network path, an invalid provider',
  ...T,
  async fn() {
    await using lab = new Lab();
    const manager = lab.manager();
    const hints = await manager.ownershipQuery() as Json;
    assert('hints' in hints && 'certainty' in hints);
    await assertRejects(() => manager.ownershipQuery('nope', 'x'));
    const error = await assertRejects(() => manager.ownershipQuery('omp', 'x', '\\\\server\\share'));
    assertEquals(error.name, 'ValueError');
    const verdict = await manager.ownershipQuery('omp', 'not-a-session', lab.dir) as Json;
    assertEquals(verdict.verdict, 'no_evidence');
  },
});

Deno.test('the host command starts the Deno host; host flags parse like agent_host.py', async () => {
  const { hostCommand } = await import('../../outputs/agent-studio/server/main.ts');
  const { parseOptions, HOST_FLAGS, UsageError } = await import('../../outputs/agent-studio/server/core/options.ts');
  const { LIVE_POST_OPS: routes } = await import('../../outputs/agent-studio/server/web/live_routes.ts');
  const { LIVE_POST_OPS } = await import('../../outputs/agent-studio/server/host/studio.ts');
  const o = parseOptions(['--state-dir', 'S', '--no-owner-announcements', '--host-idle-minutes', '2']);
  const deno = hostCommand(o);
  assertEquals(deno[0], Deno.execPath());
  assertEquals(deno.slice(1, 4), ['run', '-A', '--quiet']);
  assert(deno[4].endsWith('main.ts') && deno[5] === 'host', deno.join(' '));
  assert(deno.join(' ').endsWith('--no-owner-announcements --host-port 0 --idle-exit-minutes 2'), deno.join(' '));
  // The host parses exactly the command line the web server builds, and refuses the web server's own flags.
  const parsed = parseOptions(deno.slice(6), HOST_FLAGS);
  assertEquals([parsed.stateDir, parsed.ownersDir, parsed.idleExitMinutes, parsed.hostPort], ['S', null, 2, 0]);
  let refused = false;
  try {
    parseOptions(['--in-process'], HOST_FLAGS);
  } catch (error) {
    refused = error instanceof UsageError;
  }
  assert(refused);
  assertEquals([...LIVE_POST_OPS].sort(), [...routes].sort());
});
