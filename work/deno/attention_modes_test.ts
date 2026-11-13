/**
 * The AttentionWatcher through the real agent hosts, in all three modes, with the same fake agent (work/fake_acp.py --held-turn)
 * and the same steps; every mode must give the same announcements:
 *   in-process  a Studio in this process, agents as its children;
 *   keeper      a Studio whose agents run in the real keeper (built from keeper/ with Go); AIB "crashes" (its keeper link drops)
 *               and a new Studio takes the chats over;
 *   split       the separate agent host process (main.ts host) behind a HostProxy, as an older version's host is used.
 * Steps: a question -> one "needs you" (looked at many times); a restart of the watcher -> nothing again; the answer -> one
 * "finished"; a queued message sent right after a turn -> one "finished" for the last turn only; a turn whose helper still runs ->
 * nothing until the helper is done, then one; a muted, a hidden and an archived chat -> nothing; a chat in a git worktree folder ->
 * nothing; a question raised while no AIB watched (keeper: while no AIB ran at all) -> one.
 * Temp folders only; every process is stopped by the PID this test started or its own host file reported.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { attachHost, type HostProxy } from '../../outputs/agent-studio/server/host/host_proxy.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import { ConversationState } from '../../outputs/agent-studio/server/state/conversations.ts';
import { ProjectPrefs } from '../../outputs/agent-studio/server/state/projects.ts';
import { ViewPrefs } from '../../outputs/agent-studio/server/state/view_prefs.ts';
import { AttentionWatcher, type Fire } from '../../outputs/agent-studio/server/attention/watcher.ts';
import { RULES } from '../../outputs/agent-studio/server/attention/rules.ts';
import { DENO, Fixture, MAIN, nativePath } from './_host_fixture.ts';
import { WORK } from './_parity.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
/** fake_acp.py --held-turn as "Claude Code" (the agent host only starts agent fixtures under work/). */
const HELD_LAUNCHER = nativePath(new URL('held-turn-fixture/agent.py', WORK));

/** The watcher's side: the web server's stores in their own folder, and every announcement it makes. */
class Watch {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-attn-web-' }));
  readonly conversations = new ConversationState(this.dir);
  readonly projectPrefs = new ProjectPrefs(this.dir);
  readonly viewPrefs = new ViewPrefs(this.dir);
  readonly fired: Fire[] = [];
  watcher: AttentionWatcher | null = null;

  constructor(public host: LiveBackend) {}

  start(): AttentionWatcher {
    this.watcher = new AttentionWatcher(
      { host: this.host, conversations: this.conversations, projectPrefs: this.projectPrefs, viewPrefs: this.viewPrefs },
      { stateDir: this.dir, onFire: (f) => void this.fired.push(...f) },
    );
    return this.watcher;
  }

  async stop(): Promise<void> {
    await this.watcher?.stop();
    this.watcher = null;
  }

  /** Look (as the 2 s loop would) until `done` holds or `seconds` pass; looking keeps going while waiting. */
  async until(done: () => boolean | Promise<boolean>, what: string, seconds = 20): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await this.watcher?.poll();
      if (await done()) return;
      await pause(50);
    }
    throw new Error(`timed out waiting for ${what}; announced: ${JSON.stringify(this.fired)}`);
  }

  /** Keep looking for a while (nothing more may come). */
  async idle(ms = 1200): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.watcher?.poll();
      await pause(60);
    }
  }

  count(kind: 'needs' | 'turn', key?: string): number {
    return this.fired.filter((f) => f.kind === kind && (!key || f.key === key)).length;
  }

  cleanup(): void {
    try {
      Deno.removeSync(this.dir, { recursive: true });
    } catch { /* a file still open on Windows */ }
  }
}

interface Mode {
  name: string;
  host: LiveBackend;
  work: string;
  connect(cwd?: string): Promise<{ id: string; key: string }>;
  /** AIB goes away and comes back while the agent goes on, if the mode can (keeper); `meanwhile` runs while no AIB is there. */
  restartAround?(meanwhile: () => Promise<void>): Promise<LiveBackend>;
  close(): Promise<void>;
}

async function chatOf(host: LiveBackend, id: string): Promise<Json> {
  const list = await host.liveList();
  return ((list.connections as Json[]) ?? []).find((c) => c.id === id) ?? {};
}
async function stateOf(host: LiveBackend, id: string): Promise<Json> {
  return (await host.liveState(id, 0)) as Json;
}
const attention = async (host: LiveBackend, id: string) => ((await chatOf(host, id)).attention ?? {}) as Json;

async function call(host: LiveBackend, op: string, body: Json): Promise<Json> {
  const [status, payload] = await host.liveCall(op, body);
  if (status !== 200) throw new Error(`${op}: ${status} ${JSON.stringify(payload)}`);
  return payload as Json;
}

async function answerFirst(host: LiveBackend, id: string): Promise<void> {
  const perms = ((await stateOf(host, id)).permissions ?? []) as Json[];
  await call(host, 'permission', { id, key: perms[0].key, option: 'yes' });
}

let messages = 0;
const prompt = (host: LiveBackend, id: string, text: string, op = 'prompt') =>
  call(host, op, { id, text, clientMessageId: `m${++messages}` });

/** The steps every mode runs. */
async function scenario(mode: Mode): Promise<string[]> {
  const w = new Watch(mode.host);
  const notes: string[] = [];
  try {
    const gate = (name: string) => `${mode.work}${SEP}${name}`;
    const open = (name: string) => Deno.writeTextFileSync(gate(name), 'go');
    const { id, key } = await mode.connect();
    w.start();
    await w.idle(300);
    assertEquals(w.fired.length, 0, `${mode.name}: nothing at the start`);

    // 1. a question: one "needs you", however often it is looked at
    await prompt(mode.host, id, 'approve');
    await w.until(() => w.count('needs') === 1, 'needs you');
    await w.idle();
    assertEquals(w.count('needs'), 1, `${mode.name}: once`);
    assertEquals(w.fired[0].chat, id);

    // 2. the watcher starts again (AIB restarted): the waiting question is not news again
    await w.stop();
    w.start();
    await w.idle();
    assertEquals(w.count('needs'), 1, `${mode.name}: not again after a restart`);

    // 3. the answer ends the turn: one "finished"
    await answerFirst(mode.host, id);
    await w.until(() => w.count('turn') === 1, 'finished');
    await w.idle();
    assertEquals(w.count('turn'), 1, `${mode.name}: finished once`);

    // 4. a message queued during a turn goes out as soon as it ends: one "finished", for the last turn
    await prompt(mode.host, id, `gate:${gate('g1')}`);
    await w.until(async () => (await attention(mode.host, id)).state === 'working', 'working');
    await prompt(mode.host, id, 'queued next', 'queue');
    open('g1');
    await w.until(async () => {
      const c = await chatOf(mode.host, id);
      const q = (c.queue ?? {}) as Json;
      return (c.attention as Json).state === 'idle' && !((q.items as unknown[]) ?? []).length && w.count('turn') >= 2;
    }, 'the queued turn done');
    await w.idle();
    assertEquals(w.count('turn'), 2, `${mode.name}: one "finished" for both turns`);

    // 5. a turn whose helper still runs: nothing until the helper is done, then once
    await prompt(mode.host, id, `helper:${gate('g2')}`);
    await w.until(async () => {
      const busy = (await mode.host.busyConnections()) as Json[];
      return busy.some((b) => b.id === id && b.state === 'helpers');
    }, 'the helper running with the reply ended');
    await w.idle(1500);
    assertEquals(w.count('turn'), 2, `${mode.name}: not while the helper runs`);
    open('g2');
    open('g2.end');
    await w.until(() => w.count('turn') === 3, 'finished after the helper');
    await w.idle();
    assertEquals(w.count('turn'), 3, `${mode.name}: once after the helper`);

    // 6. muted, hidden, archived: nothing (and nothing replayed later)
    const chat = await chatOf(mode.host, id);
    const pk = RULES.pathKey(String(chat.projectRoot || chat.cwd));
    const quiet = async (what: string, on: () => Promise<unknown>, off: () => Promise<unknown>) => {
      await on();
      await prompt(mode.host, id, 'approve');
      await w.until(async () => (await attention(mode.host, id)).state === 'needs_you', `${what}: the question`);
      await w.idle(800);
      await answerFirst(mode.host, id);
      await w.until(async () => (await attention(mode.host, id)).state === 'idle', `${what}: turn end`);
      await w.idle(800);
      await off();
      await w.idle(500);
      assertEquals([w.count('needs'), w.count('turn')], [1, 3], `${mode.name}: nothing for a ${what} chat`);
    };
    await quiet(
      'muted',
      () => w.projectPrefs.update({ set: { [pk]: { muted: true } } }),
      () => w.projectPrefs.update({ set: { [pk]: { muted: false } } }),
    );
    await quiet(
      'hidden',
      () => w.projectPrefs.update({ set: { [pk]: { hidden: true } } }),
      () => w.projectPrefs.update({ set: { [pk]: { hidden: false } } }),
    );
    await quiet(
      'archived',
      () => w.conversations.apply('archive', chat.provider, chat.sessionId),
      () => w.conversations.apply('unarchive', chat.provider, chat.sessionId),
    );

    // 7. a question raised while no AIB watched: announced once when one does again
    await w.stop();
    if (mode.restartAround) {
      await prompt(mode.host, id, `helper-ask:${gate('g3')}`);
      await pause(300);
      mode.host = w.host = await mode.restartAround(async () => {
        open('g3'); // the helper asks for approval while no AIB runs; the keeper keeps it
        await pause(1500);
      });
      notes.push('restarted around the question');
    } else {
      await prompt(mode.host, id, 'approve');
      const deadline = Date.now() + 15_000;
      while ((await attention(mode.host, id)).state !== 'needs_you' && Date.now() < deadline) await pause(50);
    }
    w.start();
    await w.until(() => w.count('needs', key) === 2, 'the question raised while down');
    await w.idle();
    assertEquals(w.count('needs', key), 2, `${mode.name}: once`);
    // 8. a chat in a git worktree folder: nothing (the fake agent has one session id: the first chat ends first)
    await call(mode.host, 'disconnect', { id });
    const wtDir = `${mode.work}${SEP}repo${SEP}.git${SEP}worktrees${SEP}wt1`;
    Deno.mkdirSync(wtDir, { recursive: true });
    const wt = await mode.connect(wtDir);
    await prompt(mode.host, wt.id, 'approve');
    await w.until(async () => (await attention(mode.host, wt.id)).state === 'needs_you', 'worktree chat: the question');
    await w.idle(800);
    assertEquals(w.fired.filter((f) => f.chat === wt.id).length, 0, `${mode.name}: nothing for a worktree folder`);
    await answerFirst(mode.host, wt.id);

    await w.stop();
    return notes;
  } finally {
    await w.stop();
    w.cleanup();
  }
}

function studioMode(name: string, withKeeper: boolean): Mode & { studios: Studio[]; dir: string; state: string } {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: `aib-attn-${name}-` }));
  const state = dir + SEP + 'state';
  const work = dir + SEP + 'work';
  Deno.mkdirSync(work, { recursive: true });
  const studios: Studio[] = [];
  const make = () => {
    const keeper = withKeeper
      ? new KeeperLink({ dataDir: state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '60s'] })
      : undefined;
    const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null }, keeper ? { keeper } : {});
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => new Connection(fake('--held-turn'), cwd, provider, options);
    studios.push(studio);
    return studio;
  };
  const mode = {
    name,
    dir,
    state,
    work,
    studios,
    host: make() as LiveBackend,
    async connect(cwd = work) {
      const c = await (mode.host as unknown as Studio).connect('omp', cwd);
      return { id: c.id, key: `omp:${c.sessionId || c.id}` };
    },
    restartAround: withKeeper
      ? async (meanwhile: () => Promise<void>) => {
        const a = mode.host as unknown as Studio;
        // what a crashed AIB leaves: its keeper connection gone, its agents untouched (keeper_studio_test.ts crash)
        a.keeper!.disconnect();
        for (const c of a.connections.values()) c.sessionLease?.release();
        a.reconnectStop.set();
        studios.splice(studios.indexOf(a), 1);
        await meanwhile();
        const b = make();
        assert((await b.adoptKeeper()) >= 1, 'the new AIB takes the chats over');
        mode.host = b;
        return b as LiveBackend;
      }
      : undefined,
    async close() {
      for (const s of studios.reverse()) await s.close().catch(() => {});
      if (withKeeper) {
        const info = readKeeperInfo(state);
        if (info && pidAlive(info.pid)) {
          try {
            const client = await KeeperClient.connect(info);
            await client.shutdown(true).catch(() => {});
            client.close();
          } catch { /* gone */ }
          const deadline = Date.now() + 5000;
          while (pidAlive(info.pid) && Date.now() < deadline) await pause(100);
          if (pidAlive(info.pid)) Deno.kill(info.pid, 'SIGKILL');
        }
      }
      for (let i = 0; i < 20; i++) {
        try {
          Deno.removeSync(dir, { recursive: true });
          return;
        } catch {
          await pause(200);
        }
      }
    },
  };
  return mode;
}

Deno.test({
  name: 'attention watcher, in-process: the same announcements as every mode',
  ...T,
  async fn() {
    const mode = studioMode('inproc', false);
    try {
      await scenario(mode);
    } finally {
      await mode.close();
    }
  },
});

Deno.test({
  name: 'attention watcher, keeper: the same announcements; a question raised while no AIB ran is announced once by the next',
  ...T,
  async fn() {
    await keeperBinary();
    const mode = studioMode('keeper', true);
    try {
      assertEquals(await scenario(mode), ['restarted around the question']);
    } finally {
      await mode.close();
    }
  },
});

Deno.test({
  name: 'attention watcher, split agent host: the same announcements over the HostProxy',
  ...T,
  async fn() {
    const fixture = new Fixture();
    const launcher = HELD_LAUNCHER;
    let proxy: HostProxy | null = null;
    try {
      const flags = [...fixture.agentFlags(), '--claude-launcher', launcher, '--no-auto-reconnect'];
      await fixture.startHost(['--claude-launcher', launcher, '--no-auto-reconnect']);
      Deno.env.set('AIB_KEEPER', '0');
      proxy = await attachHost({
        stateDir: fixture.state,
        command: [DENO, 'run', '-A', '--quiet', MAIN, 'host', ...flags],
        port: 0,
        webInstanceId: 'attention-test',
        heartbeatSeconds: 3600,
      });
      const host = proxy;
      const mode: Mode = {
        name: 'split',
        host,
        work: fixture.workspace,
        async connect(cwd = fixture.workspace) {
          const c = await call(host, 'connect', { provider: 'claude', cwd, background: true });
          const id = String(c.id);
          const deadline = Date.now() + 30_000;
          let s: Json = {};
          while (Date.now() < deadline && !(s = await stateOf(host, id)).ready) await pause(100);
          return { id, key: `claude:${s.sessionId || id}` };
        },
        close: () => Promise.resolve(),
      };
      await scenario(mode);
    } finally {
      await proxy?.close().catch(() => {});
      Deno.env.delete('AIB_KEEPER');
      await fixture.cleanup();
    }
  },
});
