/**
 * A finished helper leaves nothing running (owner 2026-11-23: "for any sub agent or helper, if they are done we need to make sure we
 * shut down any processes that they started"). Through a real Studio with fake agents that start real processes (a background shell
 * and a child "dev server"), real git in temp folders, no windows, no real CLI:
 *  - a helper that is merged: both processes are gone within seconds, the registry says it ended, the parent chat gets one line, and
 *    the saved chat's process rows read "stopped: helper finished";
 *  - a done helper is ended after the idle limit (injected here; 30 minutes in the app);
 *  - a helper with a running turn or an open approval, one the owner typed into, and one that lands is NOT ended;
 *  - restart: an overdue helper is ended only once the take-over has finished (and the chat looks idle);
 *  - the chat reopens after the end, even when its worktree was removed.
 * Quitting AIB keeping working helpers is the keeper's own test (keeper_quit_e2e_test.ts, unchanged).
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, pause, PYTHON, until } from './_connection.ts';
import { commit, makeRepo, runGit } from './_worktree_fixtures.ts';
import * as fx from './_monitor_fixtures.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { Registry, stoppedWhyIn } from '../../outputs/agent-studio/server/swarm/registry.ts';
import { END_IDLE_MS, Swarm } from '../../outputs/agent-studio/server/swarm/service.ts';
import { setSwarmEnabled } from '../../outputs/agent-studio/server/swarm/settings.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import { processList } from '../../outputs/agent-studio/server/platform/process_info.ts';
import * as m from '../../outputs/agent-studio/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py');

const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass every time.',
  owns: ['test/login/**'],
  done_when: 'the login tests pass',
  reply_with: 'cause in one line',
  test_cmd: "python -c \"open('AIB_RAN_TEST_CMD','w')\"",
};

function alive(pid: number): boolean {
  if (Deno.build.os === 'windows') return processList().some((p) => p.pid === pid);
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

async function gone(pids: number[], what: string, seconds = 15): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (pids.some(alive)) {
    if (Date.now() > end) throw new Error(`still running after ${seconds} s (${what}): ${pids.filter(alive)}`);
    await pause(100);
  }
}

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-endhelper-test-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly childFile = pathOf(this.dir, 'child.pid');
  readonly gate = pathOf(this.dir, 'bg.gate');
  readonly studio: Studio;
  swarm: Swarm;
  /** What the poll's list says about the take-over at start (a restart test turns it on). */
  takingOver = false;

  constructor() {
    setSwarmEnabled(this.state, true);
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    const studio = new Studio({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0 }, { keeper: null });
    studio.ownerProbe = () => null;
    studio.agentLaunch = () => Promise.resolve([['unused'], {}]);
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(
        [PYTHON, UNIQUE, '--models', '--held-turn', '--not-claude', ...(provider === 'codex' ? ['--child-pid-file', this.childFile] : [])],
        cwd,
        provider,
        options ?? {},
      );
    this.studio = studio;
    this.swarm = this.#swarm();
  }

  #swarm(): Swarm {
    const host = this.studio;
    const swarm = new Swarm({
      stateDir: this.state,
      host: {
        liveList: async () => ({ ...(await host.liveList() as Json), takingOver: this.takingOver }),
        liveState: (id, after) => host.liveState(id, after),
        liveCall: (name, body) => host.liveCall(name, body),
      },
      settings: this.studio.settings,
    });
    swarm.openMs = 30_000;
    return swarm;
  }

  /** A new Swarm service over the same state folder, as after a restart of AIB. */
  restart(): Swarm {
    return this.swarm = this.#swarm();
  }

  /** A main chat starts a helper; the helper's brief turn ends; its commit is made; the report is delivered (state done). */
  async helper(): Promise<{ id: string; main: Connection; helper: Connection }> {
    const main = await this.studio.connect('claude', this.project, null, { ownCopy: true });
    const [, out] = await this.swarm.tool(main.id, 'start_helper', BRIEF);
    const id = String((out as Json).helper);
    await until(() => this.swarm.registry.get(id)?.state === 'working', 'the helper working', 30);
    const h = this.swarm.registry.get(id)!;
    const helper = this.studio.connections.get(h.chat.live)!;
    await until(() => !helper.busy, 'the brief turn ended', 15);
    commit(h.worktree.path, 'test/login/a.test.txt', 'fixed\n', 'fix the login tests');
    await this.swarm.poll();
    await until(() => this.swarm.registry.get(id)?.state === 'done' && this.swarm.registry.get(id)!.reports.every((r) => r.delivered), 'done and reported', 15);
    return { id, main, helper };
  }

  /** The helper starts a background shell (a real process) on top of its child "dev server" (the launch child): their pids. */
  async processes(helper: Connection): Promise<number[]> {
    await helper.prompt(`bgshell:${this.gate}`, 'swarm-test-bg'); // an AIB-style id: this is the fixture, not the owner typing
    await until(() => exists(this.childFile + '.shell'), 'the background shell', 10);
    const pids = [Number(Deno.readTextFileSync(this.childFile)), Number(Deno.readTextFileSync(this.childFile + '.shell'))];
    assert(pids.every((p) => p > 0 && alive(p)), `both run: ${pids}`);
    return pids;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.swarm.stopWatching();
    try {
      Deno.writeTextFileSync(this.gate, 'x'); // lets any waiter end
    } catch { /* gone */ }
    await this.studio.close().catch(() => {});
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

const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => e.data as Json);
const ended = (box: Box, id: string) => !!box.swarm.registry.get(id)?.ended;

Deno.test({
  ...T,
  name: 'end helper: a merged helper\'s agent, background shell and child dev server are gone in seconds; the parent gets one line',
  async fn() {
    await using box = new Box();
    const { id, main, helper } = await box.helper();
    const pids = await box.processes(helper);
    const agent = helper.process!.pid;
    await until(() => !helper.busy, 'idle', 10);
    const merged = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals((merged[1] as Json).state, 'merged', JSON.stringify(merged[1]));
    await box.swarm.poll(); // merged: ended at once
    await gone([...pids, agent], 'the helper and its processes');
    assert(helper.closed, 'its chat ended');
    const h = box.swarm.registry.get(id)!;
    assert(h.ended && h.ended.processes >= 2, `the registry says it ended with its processes: ${JSON.stringify(h.ended)}`);
    const lines = notes(main).filter((n) => n.kind === 'swarm-ended');
    assertEquals(lines.length, 1, 'one line');
    assert(
      String(lines[0].message).startsWith('Helper “Login tests” (Codex) finished; its processes were shut down ('),
      String(lines[0].message),
    );
    await box.swarm.poll();
    assertEquals(notes(main).filter((n) => n.kind === 'swarm-ended').length, 1, 'not told twice');
    // the main chat's own agent is untouched
    assert(!main.closed && alive(main.process!.pid), "the main chat's agent still runs");
  },
});

Deno.test({
  ...T,
  name: 'end helper: a done helper is ended after the idle limit (never before); stopped counts the same',
  async fn() {
    await using box = new Box();
    box.swarm.endIdleMs = 2500;
    const { id, helper } = await box.helper();
    const pids = await box.processes(helper);
    await box.swarm.poll();
    assert(!helper.closed && !ended(box, id), 'not ended before the limit');
    await until(async () => (await box.swarm.poll(), ended(box, id)), 'ended after the limit', 20);
    await gone(pids, 'its processes');
    assert(helper.closed);
    assertEquals(END_IDLE_MS, 30 * 60_000, 'the app default stays 30 minutes');
  },
});

Deno.test({
  ...T,
  name: 'end helper: not while a turn runs, an approval is open, the owner typed into it, or it is landing',
  async fn() {
    await using box = new Box();
    box.swarm.endIdleMs = 0;
    // a running turn
    const a = await box.helper();
    box.swarm.endIdleMs = 60_000; // keep the second helper's setup from ending anything
    await a.helper.prompt(`gate:${box.gate}`, 'swarm-test-run');
    await until(() => a.helper.busy, 'a turn running');
    box.swarm.endIdleMs = 0;
    for (let i = 0; i < 3; i++) await box.swarm.poll();
    assert(!a.helper.closed && !ended(box, a.id), 'a running turn is left alone');
    Deno.writeTextFileSync(box.gate, 'x');
    await until(() => !a.helper.busy, 'the turn ended', 15);
    // an open approval
    Deno.removeSync(box.gate);
    await a.helper.prompt('approve', 'swarm-test-approve');
    await until(() => a.helper.permissions.size > 0, 'an approval open', 10);
    for (let i = 0; i < 3; i++) await box.swarm.poll();
    assert(!a.helper.closed && !ended(box, a.id), 'an open approval is left alone');
    a.helper.permission([...a.helper.permissions.keys()][0], 'yes');
    await until(() => !a.helper.busy, 'answered', 10);
    // the owner types into it (an id that is not AIB's): it is his now
    await box.studio.liveCall('prompt', { id: a.helper.id, text: 'one more thing please', clientMessageId: 'page-typed-1' });
    await until(() => !a.helper.busy, 'the owner turn ended', 15);
    assertEquals(a.helper.ownerTouched, true);
    for (let i = 0; i < 3; i++) await box.swarm.poll();
    assert(!a.helper.closed && !ended(box, a.id), 'an owner-touched helper is left alone');
    // landing: a recorded landing blocks it
    await box.swarm.registry.patch(a.id, { landing: { what: 'merge', by: 'tool', queuedAt: 1, tries: 0, lastRefusal: '', waitsFor: '', stage: 'queued', lockId: '', stashSha: '', stashName: '', stashFolder: '', landed: '', tipBefore: '', toldTries: false, toldWait: false } });
    await box.swarm.poll();
    assert(!a.helper.closed, 'a landing helper is left alone');
  },
});

Deno.test({
  ...T,
  name: 'end helper: after a restart an overdue helper is ended only once the take-over has finished',
  async fn() {
    await using box = new Box();
    const { id, helper } = await box.helper();
    const pids = await box.processes(helper);
    // overdue by the registry alone (its report is old); AIB just restarted
    await box.swarm.registry.update(id, (h) => (h ? { ...h, reports: h.reports.map((r) => ({ ...r, at: r.at - 7200 })) } : null));
    const swarm = box.restart();
    swarm.endIdleMs = 1500; // the chat's own turn end is recent here; its limit has passed a moment later
    box.takingOver = true;
    await pause(2000);
    for (let i = 0; i < 3; i++) await swarm.poll();
    assert(!helper.closed && pids.every(alive), 'nothing ends while chats are still being taken over');
    await pause(2000); // the report of the shell's turn was made meanwhile: its limit is over again
    box.takingOver = false;
    await swarm.poll();
    await gone(pids, 'its processes after the take-over');
    assert(helper.closed && !!swarm.registry.get(id)?.ended);
  },
});

Deno.test({
  ...T,
  name: 'end helper: a merged helper\'s chat reopens after the end, and its worktree is removed meanwhile without a crash',
  async fn() {
    await using box = new Box();
    const { id, main, helper } = await box.helper();
    const session = helper.sessionId!;
    const path = box.swarm.registry.get(id)!.worktree.path;
    await until(() => !helper.busy, 'idle', 10);
    await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    await box.swarm.poll();
    assert(helper.closed && ended(box, id));
    const there = () => {
      try {
        return Deno.statSync(path).isDirectory;
      } catch {
        return false;
      }
    };
    await until(() => !there(), 'its worktree removed after the merge', 20);
    // reopening it now: readable but not continuable, said plainly (WorktreeGone), never a crash into the removed folder
    let said = '';
    try {
      await box.studio.connect('codex', box.project, session);
    } catch (error) {
      assertEquals((error as Error).name, 'WorktreeGone');
      said = (error as Error).message;
    }
    assert(said.includes('workspace was removed'), said);
  },
});

Deno.test({
  ...T,
  name: 'end helper: the Activity rows of an ended helper\'s chat read stopped (helper finished), others keep their state',
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-endrows-' });
    try {
      const claude = pathOf(dir, 'claude');
      fx.processFixtures(claude);
      const source = await m.Catalog.open(pathOf(dir, 'omp'), claude);
      const get = async (name: string, options: m.HandlerOptions = {}) =>
        (await m.handleGet(source, '/api/commands', `session=${encodeURIComponent(`claude/${name}/sess.jsonl`)}`, options)).body as Json;
      const plain = await get('monitorRunning');
      assertEquals(plain.running, 1, 'the fixture has a running command');
      const stopped = await get('monitorRunning', { stoppedWhy: (key) => (key.includes('/monitorRunning/') ? 'helper finished' : '') });
      assertEquals(stopped.running, 0, 'nothing counts as running');
      const rows = stopped.commands as Json[];
      assert(rows.length && rows.every((t) => t.status === 'killed' && t.stoppedReason === 'helper finished'), JSON.stringify(rows));
      const other = await get('monitorRunning', { stoppedWhy: () => '' });
      assertEquals(other.running, 1, 'another chat is untouched');
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test('end helper: stoppedWhyIn maps an ended helper to its saved chat key, and only that one', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-endwhy-' });
  try {
    const reg = new Registry(dir);
    const base = {
      project: '/p',
      parent: { live: 'x', lasting: 'claude:main' },
      brief: { goal: '', owns: [], avoid: [], done_when: '', reply_with: '', test_cmd: '', read_only: false, context_files: [] },
      worktree: { path: '', branch: '', base: '', start: '' },
      notes: [],
      reports: [],
    };
    await reg.update('h_a', () => (<never> { ...base, id: 'h_a', title: 'A', chat: { live: '', lasting: 'claude:sess-ended', provider: 'claude', model: '', mode: '' }, state: 'merged', ended: { at: 1, why: 'merged', processes: 2 } }));
    await reg.update('h_b', () => (<never> { ...base, id: 'h_b', title: 'B', chat: { live: '', lasting: 'claude:sess-live', provider: 'claude', model: '', mode: '' }, state: 'working' }));
    const why = stoppedWhyIn(dir);
    assertEquals(why('claude/proj/sess-ended.jsonl'), 'helper finished');
    assertEquals(why('claude/proj/sess-live.jsonl'), '');
    assertEquals(why('omp/proj/sess-ended.jsonl'), '', 'another provider');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  ...T,
  name: "end helper: a done helper's chat reopens after the end (its worktree kept) as a helper, and is not ended again under the owner",
  async fn() {
    await using box = new Box();
    box.swarm.endIdleMs = 1500;
    const { id, helper } = await box.helper();
    const session = helper.sessionId!;
    await until(async () => (await box.swarm.poll(), ended(box, id)), 'ended after the limit', 20);
    assert(helper.closed);
    const again = await box.studio.connect('codex', box.project, session);
    assertEquals(again.swarm?.role, 'helper');
    assert(!again.closed && again.process && alive(again.process.pid), 'a live agent again');
    box.swarm.endIdleMs = 60_000;
    await box.swarm.poll();
    assert(!box.swarm.registry.get(id)?.ended, 'its processes are live rows again');
    assert(!again.closed, 'not ended under the owner');
  },
});

Deno.test({
  ...T,
  name: 'end helper: work of a helper that was ended lands through the merge-by-worktree-record path',
  async fn() {
    await using box = new Box();
    box.swarm.endIdleMs = 1500;
    const { id, main, helper } = await box.helper();
    await until(async () => (await box.swarm.poll(), ended(box, id)), 'ended after the limit', 20);
    assert(helper.closed);
    const merged = await box.swarm.tool(main.id, 'merge_helper', { helper: id }); // no live helper: by its recorded worktree and branch
    assertEquals(merged[0], 200, JSON.stringify(merged[1]));
    assertEquals((merged[1] as Json).state, 'merged', JSON.stringify(merged[1]));
    assertEquals(box.swarm.registry.get(id)?.state, 'merged');
  },
});
