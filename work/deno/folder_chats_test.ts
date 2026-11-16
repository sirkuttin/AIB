/**
 * Build plan 1b, phase P1 (private/designs/worktree-model/build-plan-1b.md section 8, e2e 0-6 and 12): new chats work in the project
 * folder by default. Through a real Studio with fake agents and real git in temp folders:
 * - 0 (fake-agent form): a new chat's agent is started in the project folder itself (session/new cwd = P), so the agent files it under P.
 *   The real-CLI form (temp CLAUDE_CONFIG_DIR / CODEX_HOME, the P0 stub API) comes with P0's harness.
 * - 1 no ownCopy, nothing working: the folder, no worktree record, no studio/* branch.
 * - 2 ownCopy true: its own copy, and Merge lands it on main as today.
 * - 3 ownCopy missing while another folder chat is working (a turn, or a queued message): its own copy; not working: the folder.
 *     A copy chat or a helper that works does not count.
 * - 4 ownCopy true on a non-git folder: the folder, with the "couldn't make an own copy" note.
 * - 5 live sync runs for a copy chat with worktreePerChat off.
 * - 6 a folder chat is a swarm main chat: start_helper succeeds, and the helper's copy has the folder's uncommitted edits.
 * - 12 two folder chats: the second gets the grey start note naming the first, and both agents get the context line once.
 * Also: the branch route's copyable / whyNot (copyableOf) and readOwnCopy.
 */
import { assert, assertEquals } from './_assert.ts';
import { PYTHON, pause, until } from './_connection.ts';
import { FAKE } from './_connection.ts';
import { makeRepo, read, runGit, write } from './_worktree_fixtures.ts';
import { Connection, SHARED_FOLDER_CONTEXT, sharedFolderNote } from '../../outputs/agent-studio/server/acp/connection.ts';
import { readOwnCopy, Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { Swarm } from '../../outputs/agent-studio/server/swarm/service.ts';
import { setSwarmEnabled } from '../../outputs/agent-studio/server/swarm/settings.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import { copyableOf } from '../../outputs/agent-studio/server/worktrees/chat_folders.ts';
import * as merge from '../../outputs/agent-studio/server/worktrees/merge.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py'); // every chat its own session id

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-folder-chats-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly studio: Studio;
  readonly swarm: Swarm;
  /** FAKE_ACP_LOG of the n-th agent started (1-based): every line it received. */
  readonly logs: string[] = [];

  constructor() {
    setSwarmEnabled(this.state, true);
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0 }, { keeper: null });
    studio.ownerProbe = () => null;
    studio.agentLaunch = () => Promise.resolve([['unused'], {}]);
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const log = pathOf(this.dir, `agent-${this.logs.length + 1}.log`);
      this.logs.push(log);
      const env = { ...(options?.env ?? {}), FAKE_ACP_LOG: log };
      return new Connection([PYTHON, UNIQUE, '--models'], cwd, provider, { ...(options ?? {}), env });
    };
    this.studio = studio;
    this.swarm = new Swarm({ stateDir: this.state, host: studio, settings: studio.settings });
    this.swarm.openMs = 30_000;
  }

  /** What the agent of `c` received, as text ('' before it wrote anything). */
  received(c: Connection): string {
    const index = this.#agentOf.get(c);
    if (index === undefined) return '';
    try {
      return Deno.readTextFileSync(this.logs[index]);
    } catch {
      return '';
    }
  }

  readonly #agentOf = new Map<Connection, number>();

  async connect(cwd: string, options: Json = {}, provider = 'claude'): Promise<Connection> {
    const before = this.logs.length;
    const c = await this.studio.connect(provider, cwd, null, options);
    this.#agentOf.set(c, before);
    return c;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.swarm.stopWatching();
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

const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));
const branches = (project: string) => runGit(project, 'branch', '--list', 'studio/*').trim();
const sessionNewCwd = (log: string) => {
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes('"session/new"')) continue;
    try {
      return String((JSON.parse(line).params as Json).cwd);
    } catch { /* not one JSON line */ }
  }
  return '';
};
const same = (a: string, b: string) => Deno.realPathSync(a).toLowerCase() === Deno.realPathSync(b).toLowerCase();

/** Send a prompt and let its turn end (the fake agent asks one approval in a plain turn: allowed, as the user would). */
async function ask(c: Connection, text: string): Promise<void> {
  await c.prompt(text);
  const deadline = Date.now() + 15_000;
  while (c.busy && Date.now() < deadline) {
    for (const key of [...c.permissions.keys()]) c.permission(key, 'yes');
    await pause(50);
  }
  assert(!c.busy, `the turn of "${text}" ended`);
}

/** A turn that runs until the returned function is called (the fake agent's gate: prompt). */
async function holdTurn(box: Box, c: Connection, name: string): Promise<() => void> {
  const gate = pathOf(box.dir, `gate-${name}`);
  await c.prompt(`gate:${gate}`);
  assert(c.busy, 'the turn runs');
  return () => Deno.writeTextFileSync(gate, '');
}

Deno.test('readOwnCopy: true, false, missing; anything else refused', () => {
  assertEquals(readOwnCopy(true), true);
  assertEquals(readOwnCopy(false), false);
  assertEquals(readOwnCopy(undefined), null);
  assertEquals(readOwnCopy(null), null);
  let refused = '';
  try {
    readOwnCopy('yes');
  } catch (error) {
    refused = String((error as Error).message);
  }
  assert(refused.includes('ownCopy'), refused);
});

Deno.test('branch route: copyable for a git project root, whyNot with a capital for the rest', async () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-copyable-' }));
  try {
    const repo = makeRepo(pathOf(dir, 'repo'));
    assertEquals(await copyableOf(repo), { copyable: true, whyNot: '' });
    const plain = pathOf(dir, 'plain');
    Deno.mkdirSync(plain);
    assertEquals(await copyableOf(plain), { copyable: false, whyNot: 'Not a git repository' });
    Deno.mkdirSync(pathOf(repo, 'sub'));
    assertEquals(await copyableOf(pathOf(repo, 'sub')), { copyable: false, whyNot: 'The folder is not the root of its git repository' });
    const empty = pathOf(dir, 'empty');
    Deno.mkdirSync(empty);
    runGit(empty, 'init', '-q', '-b', 'main');
    assertEquals((await copyableOf(empty)).whyNot, 'The repository has no commits yet');
    assertEquals((await copyableOf(pathOf(dir, 'missing'))).copyable, false);
    assertEquals((await copyableOf('')).copyable, false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  ...T,
  name: 'e2e 0+1: a new chat with no ownCopy works in the project folder: agent cwd P, no record, no branch, a main chat',
  async fn() {
    await using box = new Box();
    const c = await box.connect(box.project);
    assertEquals(c.worktree, null);
    assert(same(c.cwd, box.project), c.cwd);
    assert(same(sessionNewCwd(box.received(c)), box.project), 'the agent itself was started in P (session/new cwd)');
    assertEquals(box.studio.worktrees!.registry.read()[0].size, 0, 'no worktree record');
    assertEquals(branches(box.project), '', 'no studio/* branch');
    assertEquals(notes(c), [], 'no start note when it is alone');
    assertEquals(c.swarm, { role: 'main' }, 'a folder chat leads helpers (MF 1)');
    assertEquals(c.public().worktree, undefined, 'live.worktree: absent for a folder chat');
  },
});

Deno.test({
  ...T,
  name: 'e2e 2: ownCopy true gets its own copy (live.worktree {branch, base}) and Merge lands it on main as today',
  async fn() {
    await using box = new Box();
    const c = await box.connect(box.project, { ownCopy: true });
    assert(c.worktree && String(c.worktree.branch).startsWith('studio/chat-'), JSON.stringify(c.worktree));
    assertEquals(c.public().worktree, { branch: c.worktree.branch, base: 'main' });
    assert(!same(c.cwd, box.project), 'works in its copy');
    assertEquals(c.projectRoot, box.project);
    write(c.cwd, 'from-copy.txt', 'copy work\n');
    const studio = box.studio;
    const merged = await merge.merge(
      { stateDir: box.state, liveState: (id) => studio.liveState(id, 0), liveCall: (op, body) => studio.liveCall(op, body) },
      c.id,
      'copy work',
    );
    assert(JSON.stringify(merged).includes('merged') || read(box.project, 'from-copy.txt') === 'copy work\n', JSON.stringify(merged));
    assertEquals(read(box.project, 'from-copy.txt'), 'copy work\n');
  },
});

Deno.test({
  ...T,
  name: 'e2e 3: ownCopy missing while another folder chat works (turn or queue): own copy; idle: the folder; copy chats never count',
  async fn() {
    await using box = new Box();
    const first = await box.connect(box.project);
    assertEquals(first.worktree, null);

    // idle: the next chat goes to the folder too
    const idleNext = await box.connect(box.project);
    assertEquals(idleNext.worktree, null, 'nothing working: the folder');
    await idleNext.close();

    // a turn running in a folder chat: the pre-set gives the new chat its own copy
    const release = await holdTurn(box, first, 'first');
    const busyNext = await box.connect(box.project);
    assert(busyNext.worktree, 'another folder chat works: own copy');
    assertEquals(notes(busyNext).filter((n) => n.includes('same folder')), [], 'no shared-folder note: it has its own copy');
    // an explicit false is kept: the folder (the person turned it off anyway)
    const forced = await box.connect(box.project, { ownCopy: false });
    assertEquals(forced.worktree, null, 'ownCopy false: the folder, even now');
    await forced.close();
    release();
    await until(() => !first.busy, 'the turn ended', 15);

    // a queued message counts as working too
    first.queue.add('q1', 'later', null, 'fp');
    const queuedNext = await box.connect(box.project);
    assert(queuedNext.worktree, 'a folder chat with a queued message: own copy');
    first.queue.remove('q1');

    // only a copy chat works: it does not write the folder, so the next chat goes to the folder
    await first.close();
    const releaseCopy = await holdTurn(box, busyNext, 'copy');
    const afterCopy = await box.connect(box.project);
    assertEquals(afterCopy.worktree, null, 'a working copy chat does not count');
    releaseCopy();
  },
});

Deno.test({
  ...T,
  name: 'e2e 4: ownCopy true on a non-git folder works in the folder with the "couldn\'t make an own copy" note',
  async fn() {
    await using box = new Box();
    const plain = pathOf(box.dir, 'plain');
    Deno.mkdirSync(plain);
    const c = await box.connect(plain, { ownCopy: true });
    assertEquals(c.worktree, null);
    assert(same(c.cwd, plain));
    assertEquals(notes(c), ["Couldn't make an own copy for this chat, so it works in the project folder: not a git repository."]);
    const quiet = await box.connect(plain);
    assertEquals(notes(quiet), [], 'no copy asked: no note');
  },
});

Deno.test({
  ...T,
  name: 'e2e 5: live sync runs for a copy chat with worktreePerChat off',
  async fn() {
    await using box = new Box();
    box.studio.settings.worktreePerChat = () => false;
    const c = await box.connect(box.project, { ownCopy: true });
    assert(c.worktree, 'a copy, whatever the old flag says');
    const sync = box.studio.liveSync!;
    assert(sync.enabled(), 'live sync no longer follows the flag');
    assert(sync.chats(box.project).some(([, record]) => same(String(record.path), c.cwd)), 'the copy chat is watched');
    write(box.project, 'tracked.txt', 'edited by the user\n');
    await until(async () => {
      await sync.turnStarted(c); // the turn-start catch-up (also what a prompt runs)
      return read(c.cwd, 'tracked.txt') === 'edited by the user\n';
    }, "the user's saved edit reached the copy", 30);
  },
});

Deno.test({
  ...T,
  name: 'e2e 6: a folder chat starts a helper (MF 1); its copy has the folder\'s uncommitted edits',
  async fn() {
    await using box = new Box();
    const main = await box.connect(box.project);
    assertEquals(main.worktree, null);
    write(box.project, 'wip.txt', 'half done\n'); // the main agent's uncommitted edit
    const providers = await box.swarm.tool(main.id, 'helper_providers', {});
    assertEquals(providers[0], 200, JSON.stringify(providers[1]));
    const started = await box.swarm.tool(main.id, 'start_helper', {
      title: 'Login tests',
      job: 'tests',
      goal: 'Make the login tests pass.',
      owns: ['test/login/**'],
      done_when: 'they pass',
      reply_with: 'one line',
      test_cmd: 'none: a test',
    });
    assertEquals(started[0], 200, JSON.stringify(started[1]));
    const id = String((started[1] as Json).helper);
    await until(() => box.swarm.registry.get(id)?.state === 'working', 'the helper working', 30);
    const h = box.swarm.registry.get(id)!;
    assertEquals(h.project, box.project, 'the folder chat is the project');
    const helper = box.studio.connections.get(h.chat.live)!;
    assert(helper.worktree && !same(helper.cwd, box.project), 'a helper always gets its own copy');
    assertEquals(read(helper.cwd, 'wip.txt'), 'half done\n', "the folder's uncommitted edit is in the helper's copy");
    // a helper never leads helpers, even though folder chats now do
    assertEquals((await box.swarm.tool(helper.id, 'start_helper', {}))[1] && ((await box.swarm.tool(helper.id, 'start_helper', {}))[1] as Json).code, 'nested');
    await box.swarm.tool(main.id, 'stop_helper', { helper: 'all', reason: 'test over' });
  },
});

Deno.test({
  ...T,
  name: 'e2e 12: two folder chats: the second gets the start note naming the first; both agents get the context line once',
  async fn() {
    await using box = new Box();
    const first = await box.connect(box.project);
    await ask(first, 'Fix login');
    // its name: the agent's own title for it (the fake agent names it "Fixture <session>"), else its first message
    const agentTitle = String(first.breadth.sessionInfo.title ?? '');
    assert(agentTitle, 'the fake agent titles its session');
    first.breadth.sessionInfo.title = '';
    assertEquals(box.studio.chatTitle(first), 'Fix login', 'no agent title: the first message');
    first.breadth.sessionInfo.title = agentTitle;
    const release = await holdTurn(box, first, 'first');
    const second = await box.connect(box.project, { ownCopy: false }); // turned Own copy off anyway
    assertEquals(second.worktree, null);
    assertEquals(notes(second), [sharedFolderNote(agentTitle)]);
    assertEquals(
      notes(second)[0],
      `Another chat (“${agentTitle}”) is working in this same folder. Its edits show up here as it makes them.`,
    );

    // the second agent: the line on its first prompt only
    await ask(second, 'hello');
    await ask(second, 'again');
    const told = box.received(second).split('\n').filter((l) => l.includes('session/prompt'));
    assertEquals(told.length, 2);
    assert(told[0].includes(SHARED_FOLDER_CONTEXT.slice(0, 40)), 'the first prompt carries the line');
    assert(!told[1].includes(SHARED_FOLDER_CONTEXT.slice(0, 40)), 'said once');
    assert(!told[1].includes('<studio-context>'), 'no empty note');

    // the first agent: on its next prompt
    release();
    await until(() => !first.busy, 'the held turn ended', 15);
    await ask(first, 'next');
    const prompts = box.received(first).split('\n').filter((l) => l.includes('session/prompt'));
    assert(prompts.at(-1)!.includes(SHARED_FOLDER_CONTEXT.slice(0, 40)), 'the working chat is told on its next prompt');
    assert(!prompts.slice(0, -1).some((l) => l.includes(SHARED_FOLDER_CONTEXT.slice(0, 40))), 'not before');
    assertEquals(notes(first), [], 'no line shown in the first chat');
  },
});
