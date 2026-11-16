/**
 * Build plan 1b, phase P3 (private/designs/worktree-model/build-plan-1b.md section 2, e2e 7-11b, 13b, 25): a helper of a chat that works
 * in the project folder lands when the main chat's turn has ended (owner decision 2b). Through a real Studio with fake agents and real git
 * in temp folders:
 * - 7   merge_helper from a busy folder parent is queued, and lands on landOn (the folder's branch) after the turn: the visible line, the
 *       parent's next-prompt line, and no automatic turn.
 * - 8   the host landing lock: while it is held, a page prompt, a steer while idle, a phone send, a helper's report and a merge prompt all
 *       queue, and go after release, in order; the lock is refused while the chat works; it ends by itself without a renewal.
 * - 9   a refused landing (index.lock) retries, with one line after 3 tries; the journal: a landing cut off after the branch moved is
 *       finished at the next start, one cut off before is rolled back into the queue, and the lock is let go.
 * - 10  no stash under a folder parent: a dirty file the landing touches means nothing lands and the parent is told; a dirty file it
 *       doesn't touch survives untouched.
 * - 10b the main agent's uncommitted edits at helper start are never committed by the landing.
 * - 11  Undo and Merge again: queued while the parent works, never a stash, and they work after the helper's branch was removed.
 * - 11b landOn is used by Merge, Undo and Merge again when the folder is on feature-x.
 * - 13b an Own-copy chat lands while a folder chat is idle: that chat's next prompt says which files changed; while it works: nothing lands.
 * - 25  (server and box text) the queue says "Sends after "…" lands (a few seconds)." while the lock is held.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, pause, PYTHON, until } from './_connection.ts';
import { makeRepo, read, runGit, write } from './_worktree_fixtures.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { landingMessage } from '../../outputs/agent-studio/server/acp/msgqueue.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { Swarm } from '../../outputs/agent-studio/server/swarm/service.ts';
import { setSwarmEnabled } from '../../outputs/agent-studio/server/swarm/settings.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import * as merge from '../../outputs/agent-studio/server/worktrees/merge.ts';
import { timing as landingTiming } from '../../outputs/agent-studio/server/worktrees/landing_lock.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import '../../outputs/agent-studio/queue-ui.js';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py'); // every chat its own session id

const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass.',
  owns: ['test/login/**'],
  done_when: 'they pass',
  reply_with: 'one line',
  test_cmd: 'none: a test',
};

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-folder-landing-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly studio: Studio;
  swarm: Swarm;
  readonly logs: string[] = [];
  readonly #agentOf = new Map<Connection, number>();

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
      // PYTHONUTF8: the fake agent logs what it reads; the landing lines have curly quotes (a real agent reads UTF-8 anyway)
      const env = { ...(options?.env ?? {}), FAKE_ACP_LOG: log, PYTHONUTF8: '1' };
      return new Connection([PYTHON, UNIQUE, '--models'], cwd, provider, { ...(options ?? {}), env });
    };
    this.studio = studio;
    this.swarm = this.newSwarm();
  }

  newSwarm(): Swarm {
    const swarm = new Swarm({ stateDir: this.state, host: this.studio, settings: this.studio.settings });
    swarm.openMs = 30_000;
    return swarm;
  }

  async connect(cwd: string, options: Json = {}, provider = 'claude'): Promise<Connection> {
    const before = this.logs.length;
    const c = await this.studio.connect(provider, cwd, null, options);
    this.#agentOf.set(c, before);
    return c;
  }

  /** The session/prompt lines the agent of `c` received. */
  prompts(c: Connection): string[] {
    const index = this.#agentOf.get(c);
    if (index === undefined) return [];
    try {
      return Deno.readTextFileSync(this.logs[index]).split('\n').filter((l) => l.includes('session/prompt'));
    } catch {
      return [];
    }
  }

  mergeStudio(): merge.MergeStudio {
    return merge.liveMergeStudio(this.state, this.studio); // what the web routes use
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
const userTexts = (c: Connection) => c.events.filter((e) => e.kind === 'user').map((e) => String((e.data as Json).text));
const stashes = (project: string) => runGit(project, 'stash', 'list').trim();
const lsTree = (project: string, ref: string, path: string) => runGit(project, 'ls-tree', '--name-only', ref, '--', path).trim();

/** Let a running turn end (the fake agent asks one approval in a plain turn: allowed, as the user would). */
async function settle(c: Connection): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (c.busy && Date.now() < deadline) {
    for (const key of [...c.permissions.keys()]) c.permission(key, 'yes');
    await pause(50);
  }
  assert(!c.busy, 'the turn ended');
}

async function ask(c: Connection, text: string): Promise<void> {
  await c.prompt(text);
  await settle(c);
}

/** A turn that runs until the returned function is called (the fake agent's gate: prompt). */
async function holdTurn(box: Box, c: Connection, name: string): Promise<() => Promise<void>> {
  const gate = pathOf(box.dir, `gate-${name}`);
  await c.prompt(`gate:${gate}`);
  assert(c.busy, 'the turn runs');
  return async () => {
    Deno.writeTextFileSync(gate, '');
    await until(() => !c.busy, 'the held turn ended', 15);
  };
}

/**
 * A folder chat starts a helper; the helper commits `file` in its copy and its turn ends; its report reaches the (idle) main chat,
 * whose turn then ends too. Returns the helper id and its copy.
 */
async function helperWithWork(
  box: Box,
  main: Connection,
  file = 'test/login/a.test.txt',
  body = 'fixed\n',
  more: (copy: string) => void = () => {},
): Promise<[string, string]> {
  const started = await box.swarm.tool(main.id, 'start_helper', BRIEF);
  assertEquals(started[0], 200, JSON.stringify(started[1]));
  const id = String((started[1] as Json).helper);
  await until(() => box.swarm.registry.get(id)?.state === 'working', 'the helper working', 30);
  const h = box.swarm.registry.get(id)!;
  const helper = box.studio.connections.get(h.chat.live)!;
  await settle(helper);
  // the helper commits its own file; `more` may change and stage more (the line-ending test stages everything, as `git add -A`)
  write(h.worktree.path, file, body);
  runGit(h.worktree.path, 'add', '--', file);
  more(h.worktree.path);
  runGit(h.worktree.path, 'commit', '-q', '-m', 'fix the login tests');
  await box.swarm.poll();
  await until(
    () => {
      const r = box.swarm.registry.get(id)?.reports ?? [];
      return r.length === 1 && r.every((x) => x.delivered);
    },
    'the report delivered',
    15,
  );
  await settle(main); // the report went as the idle main chat's next prompt
  return [id, h.worktree.path];
}

Deno.test({
  ...T,
  name: 'e2e 7, 10b, 11b: queued while the folder chat works, lands on feature-x after the turn with no stash; Undo and Merge again there',
  async fn() {
    await using box = new Box();
    runGit(box.project, 'switch', '-q', '-c', 'feature-x');
    const main = await box.connect(box.project);
    assertEquals(main.worktree, null, 'a folder chat');
    write(box.project, 'tracked.txt', 'half-done edit by the main agent\n'); // uncommitted at helper start (10b)
    write(box.project, 'wip.txt', 'new, not committed\n');
    const [id, copy] = await helperWithWork(box, main);
    const h = box.swarm.registry.get(id)!;
    assertEquals(h.worktree.landOn, 'feature-x', 'the helper lands on the folder branch');
    assertEquals(wt.recordForPath(box.state, copy)?.landOn, 'feature-x', 'landOn is in the worktree record (MF 7)');
    assertEquals(read(copy, 'tracked.txt'), 'half-done edit by the main agent\n', "the helper's copy started with the folder's edits");
    assertEquals(await merge.targetBranch(box.project, 'main', wt.recordForPath(box.state, copy)), 'feature-x');

    // merge_helper during the main agent's turn: queued
    const release = await holdTurn(box, main, 'busy');
    const mainBefore = runGit(box.project, 'rev-parse', 'main').trim();
    const tipBefore = runGit(box.project, 'rev-parse', 'feature-x').trim();
    const queued = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals((queued[1] as Json).state, 'queued', JSON.stringify(queued[1]));
    assertEquals(
      (queued[1] as Json).message,
      '“Login tests” (Codex) lands in the project folder when your turn ends. Finish your turn; the result is in your next message.',
    );
    await box.swarm.poll();
    assertEquals(runGit(box.project, 'rev-parse', 'feature-x').trim(), tipBefore, 'nothing lands while the turn runs');
    assertEquals(box.swarm.registry.get(id)!.landing?.stage, 'queued');

    // the turn ends: the next poll lands it
    await release();
    const turnsBefore = userTexts(main).length;
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)!.state, 'merged');
    assertEquals(box.swarm.registry.get(id)!.landing ?? null, null, 'the queue entry is gone');
    assertEquals(lsTree(box.project, 'feature-x', 'test/login/a.test.txt'), 'test/login/a.test.txt', 'landed on feature-x');
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), mainBefore, 'main is untouched');
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'fixed\n', 'in the folder');
    // 10b: the main agent's uncommitted edits are still uncommitted, and not in the landed commit
    assertEquals(runGit(box.project, 'show', 'feature-x:tracked.txt'), 'one\n');
    assertEquals(lsTree(box.project, 'feature-x', 'wip.txt'), '');
    assertEquals(read(box.project, 'tracked.txt'), 'half-done edit by the main agent\n');
    assertEquals(read(box.project, 'wip.txt'), 'new, not committed\n');
    assertEquals(stashes(box.project), '', 'never a stash under a folder chat');
    assert(notes(main).some((n) => n.startsWith('Merged “Login tests” (Codex) into feature-x · 1 commit')), notes(main).join('\n'));
    await pause(300);
    assertEquals(userTexts(main).length, turnsBefore, 'no automatic turn after a landing');
    assert(!main.busy);

    // the parent's next prompt carries the landed line, once
    await ask(main, 'next');
    const told = box.prompts(main).at(-1)!;
    assert(told.includes('While you were idle, helper “Login tests” (Codex) landed 1 commit in this folder'), told);
    assert(told.includes('test/login/a.test.txt'), told);
    await ask(main, 'again');
    assert(!box.prompts(main).at(-1)!.includes('While you were idle'), 'said once');

    // 11b: Undo and Merge again move feature-x, not main; the parent is idle, so they run at once
    const undone = await box.swarm.undo(id);
    assertEquals((undone[1] as Json).state, 'undone', JSON.stringify(undone[1]));
    assertEquals(lsTree(box.project, 'feature-x', 'test/login/a.test.txt'), '');
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), mainBefore);
    const again = await box.swarm.mergeAgain(id);
    assertEquals((again[1] as Json).state, 'merged', JSON.stringify(again[1]));
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'fixed\n');
    assertEquals(read(box.project, 'tracked.txt'), 'half-done edit by the main agent\n', 'still uncommitted, never stashed');
    assertEquals(stashes(box.project), '');
  },
});

Deno.test({
  ...T,
  name: 'e2e 10: a dirty file the landing touches: nothing lands, nothing is stashed, the parent is told; untouched dirty files survive',
  async fn() {
    await using box = new Box();
    const main = await box.connect(box.project);
    const [id] = await helperWithWork(box, main);
    write(box.project, 'test/login/a.test.txt', 'the main agent wrote this meanwhile\n'); // untracked, where the helper's file lands
    write(box.project, 'other.txt', 'untouched by the helper\n');
    const tip = runGit(box.project, 'rev-parse', 'main').trim();
    const q = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals((q[1] as Json).state, 'queued');
    await box.swarm.poll();
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), tip, 'nothing landed');
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'the main agent wrote this meanwhile\n');
    assertEquals(read(box.project, 'other.txt'), 'untouched by the helper\n');
    assertEquals(stashes(box.project), '', 'nothing stashed');
    const landing = box.swarm.registry.get(id)!.landing!;
    assertEquals([landing.stage, landing.waitsFor], ['queued', 'touched-dirty']);
    assert(
      notes(main).includes("Didn't land “Login tests”: it changes files with uncommitted edits (a.test.txt)."),
      notes(main).join('\n'),
    );
    await box.swarm.poll();
    assertEquals(notes(main).filter((n) => n.startsWith("Didn't land")).length, 1, 'no retry until merge_helper is called again');
    await ask(main, 'what now');
    const told = box.prompts(main).at(-1)!;
    assert(
      told.includes(
        'Helper “Login tests” (Codex) changes files you have uncommitted (test/login/a.test.txt). Commit them or set them aside, then call merge_helper again.',
      ),
      told,
    );

    // the main agent sets its file aside; merge_helper again: it lands, and the untouched dirty file is still there
    Deno.removeSync(pathOf(box.project, 'test/login/a.test.txt'));
    await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)!.state, 'merged');
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'fixed\n');
    assertEquals(read(box.project, 'other.txt'), 'untouched by the helper\n');
    assertEquals(stashes(box.project), '');
  },
});

/** The size of a blob as it is stored (runGit turns CRLF output into LF, so the bytes are counted by git). */
const blobSize = (project: string, spec: string) => Number(runGit(project, 'cat-file', '-s', spec).trim());

Deno.test({
  ...T,
  name: 'line endings: core.autocrlf=true and a helper committing every checked-out file with CRLF: the landing works, only real changes land',
  async fn() {
    await using box = new Box();
    runGit(box.project, 'config', 'core.autocrlf', 'true'); // as on the owner's machine: AIB's own git reads this; copies check out CRLF
    write(box.project, 'notes.txt', 'a\nb\nc\n');
    runGit(box.project, 'add', 'notes.txt');
    runGit(box.project, 'commit', '-q', '-m', 'notes');
    const main = await box.connect(box.project);
    write(box.project, 'tracked.txt', 'half-done edit by the main agent\n'); // uncommitted in the folder (the old churn hit it)
    const [id, copy] = await helperWithWork(box, main, 'test/login/a.test.txt', 'fixed\n', (copy) => {
      assert(Deno.readTextFileSync(pathOf(copy, '.gitignore')).includes('\r\n'), 'the copy is checked out with CRLF');
      write(copy, 'notes.txt', 'a\r\nB\r\nc\r\n'); // a real edit, saved with the checkout's CRLFs
      runGit(copy, 'add', '-A'); // a git with core.autocrlf=false (runGit's): every checked-out file is committed with its CRLFs
    });
    const churn = runGit(copy, 'diff', '--name-only', box.swarm.registry.get(id)!.worktree.start, 'HEAD').trim().split('\n').sort();
    assertEquals(churn, ['.gitignore', 'notes.txt', 'test/login/a.test.txt', 'tracked.txt'], 'the helper committed line-ending churn');
    const tip = runGit(box.project, 'rev-parse', 'main').trim();

    const q = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals((q[1] as Json).state, 'queued');
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)!.state, 'merged', JSON.stringify(box.swarm.registry.get(id)!.landing ?? null));
    const landed = runGit(box.project, 'diff', '--name-only', tip, 'main').trim().split('\n').sort();
    assertEquals(landed, ['notes.txt', 'test/login/a.test.txt'], 'only the real changes landed');
    assertEquals(blobSize(box.project, 'main:notes.txt'), 'a\nB\nc\n'.length, 'the real edit landed with the LF line endings of the repo');
    assertEquals(blobSize(box.project, 'main:.gitignore'), blobSize(box.project, `${tip}:.gitignore`));
    assertEquals(read(box.project, 'tracked.txt'), 'half-done edit by the main agent\n', "the main agent's edit is untouched");
    assertEquals(read(box.project, 'notes.txt'), 'a\nB\nc\n');
    assertEquals(stashes(box.project), '');
  },
});

Deno.test({
  ...T,
  name: 'line endings: the snapshot S of a folder with CRLF commits under `text` attributes has no line-ending-only changes',
  async fn() {
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-eol-snapshot-' }));
    try {
      const project = makeRepo(pathOf(dir, 'proj'));
      write(project, 'crlf.txt', 'one\r\ntwo\r\n');
      runGit(project, 'add', 'crlf.txt'); // committed with its CRLFs (core.autocrlf=false)
      runGit(project, 'commit', '-q', '-m', 'crlf');
      write(project, '.gitattributes', '*.txt text\n');
      runGit(project, 'add', '.gitattributes');
      runGit(project, 'commit', '-q', '-m', 'attributes');
      write(project, 'real.txt', 'a real edit\n');
      const scratch = pathOf(dir, 'scratch');
      Deno.mkdirSync(scratch);
      const s = await wt.snapshotCommit(project, scratch); // a fresh index re-reads crlf.txt: `text` would store it with LF
      assertEquals(runGit(project, 'diff', '--name-only', 'HEAD', s).trim(), 'real.txt', 'only the real change is in S');
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  ...T,
  name: 'e2e 8, 25: the landing lock: every prompt source queues while it is held and goes after release; refused while working; expires',
  async fn() {
    await using box = new Box();
    const c = await box.connect(box.project);
    const call = (op: string, body: Json) => box.studio.liveCall(op, { id: c.id, ...body });

    // refused while a turn runs
    const release = await holdTurn(box, c, 'busy');
    const refused = await call('landing-lock', { lock: 'L0', title: 'Add tests' });
    assertEquals((refused[1] as Json).ok, false);
    assertEquals((refused[1] as Json).reason, 'a turn is running');
    await release();
    await settle(c);

    const got = await call('landing-lock', { lock: 'L1', title: 'Add tests' });
    assertEquals(got[1], { ok: true, reason: '' });
    const other = await call('landing-lock', { lock: 'L2', title: 'Other' });
    assertEquals((other[1] as Json).ok, false, 'one landing at a time');

    const before = userTexts(c).length;
    const page = await call('prompt', { text: 'from the page', clientMessageId: 'm-page' });
    assertEquals([(page[1] as Json).queued, (page[1] as Json).turnState], [true, 'queued'], JSON.stringify(page[1]));
    const steer = await call('steer', { text: 'a steer while idle', clientMessageId: 'm-steer' });
    assertEquals((steer[1] as Json).state, 'queued', 'steer-on-send while idle is rerouted into the queue');
    const phone = await call('steer', { text: 'from the phone', clientMessageId: 'm-phone' }); // /api/remote/steer → op steer
    assertEquals((phone[1] as Json).state, 'queued');
    const report = await call('steer', { text: '[AIB helper report h_00000002 #1: data]', clientMessageId: 'swarm-report-h_00000002-1' });
    assertEquals((report[1] as Json).state, 'queued', "a second helper's report waits too");
    const clash = await call('prompt', { text: 'merge clash guidance', clientMessageId: 'merge-clash-x' });
    assertEquals((clash[1] as Json).queued, true, 'a merge prompt waits too');
    assert(!c.busy, 'no turn started');
    assertEquals(userTexts(c).length, before);

    // 25: what the page sees
    const queue = c.queuePublic() as Json;
    assertEquals([queue.landing, queue.paused, queue.message], ['Add tests', false, landingMessage('Add tests')]);
    assertEquals(queue.message, 'Sends after “Add tests” lands (a few seconds).');
    const ui = (globalThis as unknown as { AgentQueueUI: { summary(q: unknown, busy: boolean): Json } }).AgentQueueUI;
    const box25 = ui.summary(queue, false);
    assertEquals(box25.head, '5 queued · Sends after “Add tests” lands (a few seconds).');
    assertEquals([box25.tone, box25.resume], ['', false], 'not shown as paused, no Resume');

    // released: they go, in order, one per turn
    assertEquals((await call('landing-release', { lock: 'L2' }))[1], { ok: false }, 'only the holder lets go');
    assertEquals((await call('landing-release', { lock: 'L1' }))[1], { ok: true });
    assertEquals((c.queuePublic() as Json).landing, undefined);
    for (let i = 0; i < 5; i++) {
      await until(() => c.busy || userTexts(c).length >= before + 5, 'the next one went', 15);
      await settle(c);
    }
    await until(() => userTexts(c).length >= before + 5, 'all five sent', 15);
    assertEquals(userTexts(c).slice(before), [
      'from the page',
      'a steer while idle',
      'from the phone',
      '[AIB helper report h_00000002 #1: data]',
      'merge clash guidance',
    ]);

    // with no renewal the host lets go by itself, and what waited goes
    assertEquals((await call('landing-lock', { lock: 'L3', title: 'Gone', ttlMs: 100 }))[1], { ok: true, reason: '' });
    await call('prompt', { text: 'after the expiry', clientMessageId: 'm-late' });
    assert(!c.busy);
    await until(() => c.busy || userTexts(c).includes('after the expiry'), 'the lock expired and the message went', 10);
    await settle(c);
    assertEquals(c.landing, null);
  },
});

Deno.test({
  ...T,
  name: 'e2e 9: a refused landing (index.lock) retries with one line after 3 tries; the journal finishes or rolls back after a stop',
  async fn() {
    await using box = new Box();
    const main = await box.connect(box.project);
    const [id] = await helperWithWork(box, main);
    const lock = pathOf(box.project, '.git', 'index.lock');
    Deno.writeTextFileSync(lock, '');
    await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    for (let i = 0; i < 4; i++) await box.swarm.poll();
    const L = box.swarm.registry.get(id)!.landing!;
    assertEquals(L.stage, 'queued');
    assert(L.tries >= 3, String(L.tries));
    const lines = notes(main).filter((n) => n.startsWith("Couldn't land “Login tests” yet:"));
    assertEquals(lines.length, 1, notes(main).join('\n'));
    assert(lines[0].endsWith('It will try again when the chat is next idle.'), lines[0]);
    assertEquals(main.landing, null, 'the lock was let go after each try');
    Deno.removeSync(lock);
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)!.state, 'merged');

    // a landing cut off after the branch moved (stage 'moved'), its lock still held: the next start finishes it and lets go
    await box.swarm.undo(id);
    const tip = runGit(box.project, 'rev-parse', 'main').trim();
    write(box.project, 'test/login/b.test.txt', 'second\n');
    runGit(box.project, 'add', 'test/login/b.test.txt');
    runGit(box.project, 'commit', '-q', '-m', 'landed before the stop');
    const landed = runGit(box.project, 'rev-parse', 'main').trim();
    await box.studio.liveCall('landing-lock', { id: main.id, lock: 'land_cutoff', title: 'Login tests' });
    await box.swarm.registry.patch(id, {
      state: 'done',
      landing: { ...cutOff('moved', landed, tip), lockId: 'land_cutoff' },
    });
    await box.swarm.stopWatching();
    box.swarm = box.newSwarm(); // a new web process: nothing runs this landing
    await box.swarm.poll();
    const done = box.swarm.registry.get(id)!;
    assertEquals([done.state, done.landing ?? null, done.merge?.landed], ['merged', null, landed]);
    assert(notes(main).some((n) => n.endsWith('finished after a restart')), notes(main).join('\n'));
    assertEquals(main.landing, null, 'the cut-off lock was let go');

    // one cut off before the branch moved (stage 'built', the commit not on main): back in the queue, then landed when idle
    await box.swarm.registry.patch(id, {
      state: 'done',
      merge: null,
      landing: cutOff('built', 'f'.repeat(40), landed),
    });
    const box2 = box.newSwarm();
    await box2.poll(); // recovers: back to queued (and, the parent idle, tries to land at once)
    const after = box2.registry.get(id)!;
    assert(after.landing === null || after.landing?.stage === 'queued', JSON.stringify(after.landing));
    await box2.stopWatching();
  },
});

function cutOff(stage: 'built' | 'moved', landed: string, tipBefore: string) {
  return {
    what: 'merge' as const,
    by: 'tool' as const,
    queuedAt: Date.now() / 1000,
    tries: 0,
    lastRefusal: '',
    waitsFor: '',
    stage,
    lockId: '',
    stashSha: '',
    stashName: '',
    stashFolder: '',
    landed,
    tipBefore,
    toldTries: false,
    toldWait: false,
  };
}

Deno.test({
  ...T,
  name: "e2e 11: Undo and Merge again are queued while the folder chat works, never stash, and work after the helper's branch is gone",
  async fn() {
    await using box = new Box();
    const main = await box.connect(box.project);
    const [id, copy] = await helperWithWork(box, main);
    await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)!.state, 'merged');
    write(box.project, 'mine.txt', 'my own edit\n');

    const release = await holdTurn(box, main, 'busy');
    const queued = await box.swarm.undo(id);
    assertEquals((queued[1] as Json).state, 'queued', JSON.stringify(queued[1]));
    await box.swarm.poll();
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'fixed\n', 'nothing changes while the turn runs');
    await release();
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)!.merge?.undo !== null, true, 'undone after the turn');
    assertEquals(lsTree(box.project, 'main', 'test/login/a.test.txt'), '');
    assertEquals(read(box.project, 'mine.txt'), 'my own edit\n');
    assertEquals(stashes(box.project), '');

    // the helper's copy and branch are removed: Merge again still works (it needs only the commits)
    const branch = box.swarm.registry.get(id)!.worktree.branch;
    const helperChat = box.studio.connections.get(box.swarm.registry.get(id)!.chat.live);
    await helperChat?.close();
    runGit(box.project, 'worktree', 'remove', '--force', copy);
    runGit(box.project, 'branch', '-D', branch);
    const again = await box.swarm.mergeAgain(id);
    assertEquals((again[1] as Json).state, 'merged', JSON.stringify(again[1]));
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'fixed\n');
    assertEquals(stashes(box.project), '');
  },
});

Deno.test({
  ...T,
  name: 'e2e 13b: an Own-copy chat lands while a folder chat is idle (its next prompt is told); while that chat works, nothing lands',
  async fn() {
    await using box = new Box();
    const folderChat = await box.connect(box.project);
    const copyChat = await box.connect(box.project, { ownCopy: true });
    assert(copyChat.worktree);
    write(copyChat.cwd, 'feature.txt', 'from the copy\n'); // only its own file (see helperWithWork)
    runGit(copyChat.cwd, 'add', '--', 'feature.txt');
    runGit(copyChat.cwd, 'commit', '-q', '-m', 'copy work');

    // the folder chat works: the merge refuses, nothing lands, nothing is stashed
    write(box.project, 'dirty.txt', 'the folder agent is mid-edit\n');
    const release = await holdTurn(box, folderChat, 'busy');
    const tip = runGit(box.project, 'rev-parse', 'main').trim();
    let refused: merge.Refused | null = null;
    try {
      await merge.merge(box.mergeStudio(), copyChat.id, 'Copy work');
    } catch (error) {
      refused = error as merge.Refused;
    }
    assertEquals(refused?.code, 'folder_busy', String(refused?.message));
    assert(String(refused?.message).includes('is working in the project folder'), String(refused?.message));
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), tip);
    assertEquals(stashes(box.project), '');
    await release();

    // idle: it lands; the folder chat's next prompt says which files changed under it
    const out = await merge.merge(box.mergeStudio(), copyChat.id, 'Copy work');
    assertEquals(out.state, 'merged');
    assertEquals(read(box.project, 'feature.txt'), 'from the copy\n');
    assertEquals(read(box.project, 'dirty.txt'), 'the folder agent is mid-edit\n');
    assertEquals(folderChat.landing, null, 'the lock was let go');
    await ask(folderChat, 'carry on');
    const told = box.prompts(folderChat).at(-1)!;
    assert(told.includes('While you were idle, the work of “Copy work” landed in this folder (files: feature.txt)'), told);
  },
});

Deno.test({
  ...T,
  name: 'e2e 13: live sync from a folder whose agent is mid-edit into a helper that touched the same file: never overwritten either way',
  async fn() {
    await using box = new Box();
    const main = await box.connect(box.project);
    const [id, copy] = await helperWithWork(box, main, 'tracked.txt', 'helper line\n');
    const helper = box.studio.connections.get(box.swarm.registry.get(id)!.chat.live)!;
    write(box.project, 'tracked.txt', 'main agent mid-edit\n'); // the main agent's unsaved-to-git edit of the same file
    await box.studio.liveSync!.turnStarted(helper); // the helper's next turn boundary: live sync brings the folder's edits in
    assert(read(copy, 'tracked.txt').includes('helper line'), `the helper's change is not overwritten: ${read(copy, 'tracked.txt')}`);
    await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    await box.swarm.poll();
    assertEquals(read(box.project, 'tracked.txt'), 'main agent mid-edit\n', "the main agent's edit is not overwritten by the landing");
    // live sync's own clash record stops it first: the helper was asked to combine both versions in its copy; nothing landed
    assertEquals(box.swarm.registry.get(id)!.landing ?? null, null);
    assert(
      notes(main).at(-1)!.startsWith("Couldn't land “Login tests”: waiting for the chat to resolve a clash with your edits in tracked.txt"),
      notes(main).at(-1)!,
    );
    assertEquals(stashes(box.project), '');
  },
});

Deno.test({
  ...T,
  name: "e2e 9 (SF 3): a copy parent's merge cut off after it stashed the folder: the next start puts the stash back and says so",
  async fn() {
    await using box = new Box();
    const main = await box.connect(box.project, { ownCopy: true }); // a copy parent: its helpers' merges still stash the folder
    const [id] = await helperWithWork(box, main);
    write(box.project, 'mine.txt', 'my unsaved work\n');
    runGit(box.project, 'stash', 'push', '-u', '-m', 'studio-merge-cutoff'); // what land() did just before the stop (temp repo)
    const sha = runGit(box.project, 'rev-parse', 'stash@{0}').trim();
    assert(!exists(pathOf(box.project, 'mine.txt')));
    await box.swarm.registry.patch(id, {
      landing: { ...cutOff('moved', '', ''), stage: 'stashed', stashSha: sha, stashName: 'studio-merge-cutoff', stashFolder: box.project },
    });
    await box.swarm.stopWatching();
    box.swarm = box.newSwarm();
    await box.swarm.poll();
    assertEquals(read(box.project, 'mine.txt'), 'my unsaved work\n', 'put back');
    assertEquals(stashes(box.project), '', 'and the entry dropped');
    assertEquals(box.swarm.registry.get(id)!.landing ?? null, null);
    assert(notes(main).some((n) => n.includes('Your uncommitted edits were set aside then and are back now')), notes(main).join('\n'));
    assert(
      notes(main).some((n) => n.startsWith('Merging “Login tests” was cut off when AIB stopped; nothing landed')),
      notes(main).join('\n'),
    );
  },
});

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  ...T,
  name: 'e2e 8 (renewal): a landing that runs longer than the lock lifetime keeps it (renewed), so nothing starts mid-landing',
  async fn() {
    await using box = new Box();
    const folderChat = await box.connect(box.project);
    const copyChat = await box.connect(box.project, { ownCopy: true });
    write(copyChat.cwd, 'slow.txt', 'from the copy\n');
    runGit(copyChat.cwd, 'add', '--', 'slow.txt');
    runGit(copyChat.cwd, 'commit', '-q', '-m', 'slow');
    const saved = { ...landingTiming };
    Object.assign(landingTiming, { renewMs: 40, ttlMs: 150 });
    let during: Json = {};
    merge.HOOKS.before_ff = async () => {
      await box.studio.liveCall('prompt', { id: folderChat.id, text: 'sent mid-landing', clientMessageId: 'mid' });
      await pause(600); // four lifetimes
      during = { held: !!folderChat.landing, busy: folderChat.busy, queued: folderChat.queue.items.length };
    };
    try {
      const out = await merge.merge(box.mergeStudio(), copyChat.id, 'Slow work');
      assertEquals(out.state, 'merged');
    } finally {
      delete merge.HOOKS.before_ff;
      Object.assign(landingTiming, saved);
    }
    assertEquals(during, { held: true, busy: false, queued: 1 }, 'still held, nothing started');
    await until(() => userTexts(folderChat).includes('sent mid-landing'), 'it went after the landing', 10);
    await settle(folderChat);
  },
});
