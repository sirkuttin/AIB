/**
 * The helper flows of a WSL project (swarm/service.ts over wsl/helpers.ts and the distro's helper/helpers.ts), written once and run
 * twice: on fakes (wsl_helpers_test.ts: a FakeWslHost answers from the real helper methods over temp folders on this PC) and in a real
 * distro (wsl_helpers_e2e_test.ts, AIB_WSL_E2E: the distro's own helper program, Linux git, throwaway folders under /tmp).
 *
 * The Swarm is the real one. Only the chat side is a stub (SwarmLab): AIB's connect makes the helper's worktree through the same
 * wsl/worktrees.ts calls aib.ts makes (plan on the folder's branch, create), then answers with the state a live helper chat has;
 * the test plays the helper (its commits in the worktree) and its turn end. Everything else (the worktree, the landing, the
 * journal, the conflict hand-off, the keep and discard of unlanded work) runs through the distro's helper.
 */
import { assert, assertEquals } from './_assert.ts';
import { Swarm } from '../../app/server/swarm/service.ts';
import { setSwarmEnabled } from '../../app/server/swarm/settings.ts';
import { wslLoc } from '../../app/server/wsl/access.ts';
import { wslCreate, wslPlanWithReason } from '../../app/server/wsl/worktrees.ts';
import { hiddenFromLists, readHelpers } from '../../app/server/swarm/registry.ts';

type Json = Record<string, unknown>;

export const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass every time.',
  owns: ['test/login/**'],
  done_when: 'the login tests pass',
  reply_with: 'cause in one line',
  test_cmd: 'none: the brief is not run here',
};

/** What a scenario needs of "the distro": a fresh git repo on main, and shell-free file and git access to Linux paths. */
export interface Env {
  readonly distro: string;
  /** A new repo (branch main, `tracked.txt` committed, `test/` and `src/` folders not yet) at a new Linux path; the Swarm's home is a Windows temp folder. */
  newRepo(): Promise<string>;
  git(linuxDir: string, ...args: string[]): Promise<string>;
  write(linuxDir: string, name: string, text: string): Promise<void>;
  read(linuxDir: string, name: string): Promise<string>;
  exists(linuxPath: string): Promise<boolean>;
  /** Everything this env made is removed. */
  dispose(): Promise<void>;
}

export const refOf = (env: Env, linux: string) => `wsl://${env.distro}${linux}`;

/** A commit of `name` in a Linux folder (the helper's work). */
export async function commitIn(env: Env, dir: string, name: string, text: string, message: string): Promise<void> {
  await env.write(dir, name, text);
  await env.git(dir, 'add', '-A');
  await env.git(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', message);
}

const PARENT = 'parent0001';
const until = async (what: string, check: () => boolean | Promise<boolean>, seconds = 60) => {
  const end = Date.now() + seconds * 1000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** A Swarm over a stub chat host in front of a WSL project. */
export class SwarmLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-helpers-' }));
  readonly chats = new Map<string, Json>();
  readonly calls: [string, Json][] = [];
  readonly swarm: Swarm;
  readonly projectRef: string;
  /** What a forking connect reports for the new chat: the agent copied its session ('copy') or could not ('summary'). */
  forkHow: 'copy' | 'summary' = 'copy';
  #n = 0;

  constructor(readonly env: Env, readonly repo: string) {
    this.projectRef = refOf(env, repo);
    setSwarmEnabled(this.dir, true);
    // the main chat works in the project folder (every new chat does): a folder chat, so its helpers start on the folder's branch and land there
    this.chats.set(PARENT, {
      id: PARENT,
      provider: 'claude',
      sessionId: 'p1',
      cwd: this.projectRef,
      closed: false,
      state: 'ready',
      busy: false,
      attention: { state: 'idle', turnEndedAt: '' },
      queue: { items: [] },
    });
    this.swarm = new Swarm({
      stateDir: this.dir,
      host: {
        liveList: () => Promise.resolve({ connections: [...this.chats.values()] }),
        liveState: (id) => Promise.resolve(this.chats.get(String(id)) ?? null),
        liveCall: (name, body) => this.#call(name, (body ?? {}) as Json),
      },
      settings: { builtinEnabled: () => true, betaEnabled: () => true },
    });
    this.swarm.openMs = 30_000;
    this.swarm.landedDebounceMs = 0;
  }

  async #call(name: string, body: Json): Promise<[number, unknown]> {
    this.calls.push([name, body]);
    switch (name) {
      case 'connect': {
        // what Aib.connect does for a helper of a folder chat in a WSL project: plan on the folder's branch, make the worktree
        const { plan, reason } = await wslPlanWithReason(String(body.cwd), 'helper', true);
        if (!plan) return [409, { error: `no worktree: ${reason}` }];
        await wslCreate(plan);
        const id = `helperchat${++this.#n}`;
        this.chats.set(id, {
          id,
          provider: String(body.provider),
          sessionId: `hs${this.#n}`,
          cwd: plan.path,
          projectRoot: String(body.cwd),
          worktree: { branch: plan.branch, base: plan.base },
          closed: false,
          setupDone: true,
          ready: true,
          cursor: 1,
          state: 'ready',
          busy: false,
          pickResults: [{ kind: 'mode', ok: true, value: 'auto' }],
          forkHow: body.forkFrom ? this.forkHow : '',
          attention: { state: 'working', turnEndedAt: '' },
          queue: { items: [] },
          events: [],
        });
        return [200, { id }];
      }
      case 'landing-lock':
        return [200, { ok: true }];
      case 'folder-chats':
        return [200, { chats: [] }];
      case 'helper-end':
        return [200, { ok: true, processes: 0 }];
      default:
        return [200, { ok: true }];
    }
  }

  /** The main chat's live state (what the tools call with). */
  get parent(): Json {
    return this.chats.get(PARENT)!;
  }

  async start(overrides: Json = {}): Promise<{ id: string; linux: string; chat: string }> {
    const [status, out] = await this.swarm.tool(PARENT, 'start_helper', { ...BRIEF, ...overrides });
    assertEquals(status, 200, JSON.stringify(out));
    const id = String((out as Json).helper);
    await until('the helper working', () => this.swarm.registry.get(id)?.state === 'working');
    const h = this.swarm.registry.get(id)!;
    const loc = wslLoc(h.worktree.path);
    assert(loc, `its worktree is a WSL ref: ${h.worktree.path}`);
    return { id, linux: loc.linuxPath, chat: h.chat.live };
  }

  /** The helper's turn ends (idle, a new turn end): the next poll builds its report and, with changes, lands it. */
  endTurn(chat: string): void {
    this.chats.get(chat)!.attention = { state: 'idle', turnEndedAt: new Date(Date.now() + ++this.#n * 1000).toISOString() };
  }

  close(chat: string): void {
    this.chats.delete(chat);
  }

  /** Lines the main chat got: reports and landing results (steer lane), and the lines held for its next prompt. */
  steers(): string[] {
    return this.calls.filter(([n]) => n === 'steer' || n === 'queue' || n === 'prompt-context').map(([, b]) =>
      String(b.text ?? b.line ?? '')
    );
  }

  prompts(chat: string): string[] {
    return this.calls.filter(([n, b]) => n === 'prompt' && b.id === chat).map(([, b]) => String(b.text ?? ''));
  }

  /** The parent's live state for the unlanded-work tool. */
  caller(): Json {
    return { ...this.parent, projectRoot: this.projectRef };
  }

  async dispose(): Promise<void> {
    await this.swarm.stopWatching();
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

/**
 * Left-list helpers in a WSL project (owner 2026-11-27): chat:true is refused unless the user started the turn, and listed when
 * allowed; Add to chat list / Move to Activity list; a fork (copy and summary) makes its own copy in the distro, is named
 * "<chat> (fork)", listed under the main chat, and its summary or its "Copy of" line says which.
 */
export async function listedAndFork(env: Env): Promise<void> {
  await withLab(env, async (lab) => {
    lab.parent.sessionId = 'p1';
    // the user did not start this turn: no chat
    lab.parent.turnByUser = false;
    const refused = (await lab.swarm.tool(PARENT, 'start_helper', { ...BRIEF, chat: true }))[1] as Json;
    assertEquals(refused.code, 'not_user_turn');
    // the user asked for a chat with it
    lab.parent.turnByUser = true;
    const asked = await lab.start({ chat: true, owns: ['test/asked/**'] });
    const a = lab.swarm.registry.get(asked.id)!;
    assertEquals([a.listed, a.byUser], [true, true]);
    assertEquals(hiddenFromLists(a), false);
    assert(a.worktree.path.startsWith('wsl://'), 'its copy is in the distro: ' + a.worktree.path);
    // an Activity-only helper, added to the chat list from Activity and moved back
    lab.parent.turnByUser = false;
    const plain = await lab.start({ owns: ['test/plain/**'] });
    assertEquals(hiddenFromLists(lab.swarm.registry.get(plain.id)), true);
    assertEquals((await lab.swarm.setListed(plain.id, true))[0], 200);
    assertEquals(hiddenFromLists(lab.swarm.registry.get(plain.id)), false);
    assertEquals((await lab.swarm.setListed(plain.id, false))[0], 200);
    assertEquals(hiddenFromLists(lab.swarm.registry.get(plain.id)), true);
    // fork, the agent copies its session
    lab.forkHow = 'copy';
    const [code, made] = await lab.swarm.fork({ id: PARENT, title: 'Login chat' });
    assertEquals(code, 200, JSON.stringify(made));
    const copyId = String((made as Json).helper);
    await until('the copy fork open', () => lab.swarm.registry.get(copyId)?.fork?.how === 'copy');
    const copy = lab.swarm.registry.get(copyId)!;
    assertEquals([copy.title, copy.listed, copy.byUser, copy.parent.live], ['Login chat (fork)', true, true, PARENT]);
    assertEquals(wslLoc(copy.worktree.path)?.distro, env.distro, 'its own git copy is in the distro');
    assertEquals(lab.prompts(copy.chat.live), [], 'waiting for the first message');
    assert(
      lab.calls.some(([n, b]) => n === 'swarm-note' && b.id === copy.chat.live && String(b.message).startsWith('Copy of “Login chat”')),
      'its first line says Copy of',
    );
    assert(
      lab.calls.some(([n, b]) => n === 'swarm-note' && b.id === PARENT && b.message === 'Forked “Login chat” into “Login chat (fork)” · in your chat list'),
      'one line in the main chat',
    );
    // fork, a written summary
    lab.forkHow = 'summary';
    lab.parent.events = [
      { kind: 'user', data: { text: 'Fix the login page' } },
      { kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Fixed.' } } } },
    ];
    const [code2, made2] = await lab.swarm.fork({ id: PARENT, title: 'Login chat' });
    assertEquals(code2, 200, JSON.stringify(made2));
    const sumId = String((made2 as Json).helper);
    await until('the summary fork open', () => lab.swarm.registry.get(sumId)?.fork?.how === 'summary');
    const sum = lab.swarm.registry.get(sumId)!;
    // the summary is no turn: it is put in front of the user's first message (prompt-context) and the chat shows a note
    const given = () => lab.calls.filter(([n, b]) => n === 'prompt-context' && b.id === sum.chat.live).map(([, b]) => String(b.line ?? ''));
    await until('the summary given', () => given().length === 1);
    assert(given()[0].startsWith('Summary of “Login chat”') && given()[0].includes('Fix the login page'), given()[0].slice(0, 120));
    assertEquals(lab.prompts(sum.chat.live), [], 'no prompt: it waits for the first message');
    // forks and asked-for chats are not agent-started helpers: only the plain one holds a place of the cap
    const caps = ((await lab.swarm.tool(PARENT, 'helper_providers', {}))[1] as { caps: Json }).caps;
    assertEquals(caps.running, 1);
  });
}

async function withLab(env: Env, run: (lab: SwarmLab, repo: string) => Promise<void>): Promise<void> {
  const repo = await env.newRepo();
  const lab = new SwarmLab(env, repo);
  try {
    await run(lab, repo);
  } finally {
    await lab.dispose();
  }
}

// ---- the scenarios ----------------------------------------------------------------------------------------------------------------

/**
 * start, status, report, land on end, and the copy's removal once its chat closed. The main chat's own uncommitted file stays
 * its own: it is in the helper's starting snapshot, but it never lands.
 */
export async function startAndLand(env: Env): Promise<void> {
  await withLab(env, async (lab, repo) => {
    await env.write(repo, 'mine.txt', 'my own unsaved work\n');
    const { id, linux, chat } = await lab.start();
    const h = lab.swarm.registry.get(id)!;
    assertEquals(h.project, lab.projectRef);
    assert(h.worktree.key, "the distro's worktree record is kept");
    assert(h.worktree.branch.startsWith('studio/helper-'), h.worktree.branch);
    assertEquals(h.worktree.landOn, 'main', "a folder chat's helper lands on the folder's branch");
    assert(linux !== repo && !linux.startsWith(repo + '/'), 'never in the project folder');
    assertEquals(await env.read(linux, 'mine.txt'), 'my own unsaved work\n', 'it starts from the folder with its uncommitted edits');
    assertEquals(await env.exists(linux + '/tracked.txt'), true);
    // status (the tool): the helper is working
    const status = (await lab.swarm.tool(PARENT, 'helper_status', { helper: id }))[1] as { helpers: Json[] };
    assertEquals(status.helpers.map((x) => [x.id, x.state, x.branch]), [[id, 'working', h.worktree.branch]]);
    // the helper's work: a commit and a file it did not commit
    await commitIn(env, linux, 'test/login/a.test.txt', 'fixed\n', 'fix the login tests');
    await env.write(linux, 'test/login/b.txt', 'not committed yet\n');
    lab.endTurn(chat);
    await lab.swarm.poll();
    await until('the helper landed', () => lab.swarm.registry.get(id)?.state === 'merged');
    const done = lab.swarm.registry.get(id)!;
    assertEquals(done.reports.length, 1);
    assert(lab.steers().some((t) => t.includes(`[AIB helper report ${id} #`)), 'the main agent got the wrapped report');
    assertEquals(await env.git(repo, 'show', 'main:test/login/a.test.txt'), 'fixed');
    assertEquals(await env.git(repo, 'show', 'main:test/login/b.txt'), 'not committed yet', 'its uncommitted work was kept and landed');
    assertEquals(
      (await env.git(repo, 'ls-tree', '--name-only', 'main')).split('\n').includes('mine.txt'),
      false,
      "the folder's own file did not land",
    );
    assertEquals(await env.read(repo, 'mine.txt'), 'my own unsaved work\n');
    assert(done.merge && done.merge.tipBefore && done.merge.landed, JSON.stringify(done.merge));
    assertEquals(done.merge.commits >= 1, true);
    await lab.swarm.flushLanded();
    assert(
      lab.steers().some((t) => t.includes('Login tests') && /landed/i.test(t) && t.includes('main')),
      `the landing was told: ${lab.steers().join(' | ')}`,
    );
    // the copy stays while its chat is open, and goes once it closes (worktree and branch)
    assertEquals(await env.exists(linux), true);
    lab.close(chat);
    lab.swarm.clock = () => Date.now() + 120_000; // the cleanup sweep runs again
    await lab.swarm.poll();
    await until('the copy removed', async () => !(await env.exists(linux)));
    assertEquals(await env.git(repo, 'branch', '--list', h.worktree.branch), '');
    assert(lab.swarm.registry.get(id)!.cleanedAt, 'recorded as cleaned up');
  });
}

/**
 * Conflicts. While the helper's chat is open it is asked to resolve them (a prompt in its chat) and the work lands after it
 * does; once its chat is closed, nothing lands and the main agent gets a clean `-landable` branch of the helper's own changes.
 */
export async function conflicts(env: Env): Promise<void> {
  await withLab(env, async (lab, repo) => {
    // open chat: the helper resolves
    const a = await lab.start({ title: 'A', owns: ['src/a/**'] });
    await env.write(a.linux, 'src/a/new.txt', "the helper's new file\n");
    await commitIn(env, a.linux, 'tracked.txt', 'helper line\n', 'helper edit');
    await commitIn(env, repo, 'tracked.txt', 'main line\n', 'main edit');
    lab.endTurn(a.chat);
    await lab.swarm.poll();
    await until('the helper asked to resolve', () => lab.prompts(a.chat).some((t) => t.includes('tracked.txt')));
    assertEquals(lab.swarm.registry.get(a.id)!.state, 'done', 'nothing landed');
    assertEquals(await env.git(repo, 'show', 'main:tracked.txt'), 'main line');
    assert(
      lab.steers().some((t) => t.includes('conflicts') && t.includes('tracked.txt')),
      `the main agent was told: ${lab.steers().join(' | ')}`,
    );
    // the helper resolves in its worktree and commits (merge in progress there: main was brought in). Landing is by tree against the
    // folder snapshot, so the resolution keeps main's lines in the file both touched, and its own new file lands.
    await env.write(a.linux, 'tracked.txt', 'main line\n');
    await env.git(a.linux, 'add', '-A');
    await env.git(a.linux, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'resolve');
    lab.endTurn(a.chat);
    const merged = await lab.swarm.tool(PARENT, 'merge_helper', { helper: a.id });
    assertEquals(merged[0], 200, JSON.stringify(merged[1]));
    await lab.swarm.poll();
    await until('the resolved work landed', () => lab.swarm.registry.get(a.id)?.state === 'merged');
    assertEquals(await env.git(repo, 'show', 'main:src/a/new.txt'), "the helper's new file");
    assertEquals(await env.git(repo, 'show', 'main:tracked.txt'), 'main line');

    // closed chat: a landable branch for the main agent
    const b = await lab.start({ title: 'B', owns: ['src/b/**'] });
    await commitIn(env, b.linux, 'other.txt', 'helper b line\n', 'helper b');
    await commitIn(env, repo, 'other.txt', 'main other line\n', 'main other');
    lab.close(b.chat); // it ended its work and its chat closed before AIB landed it (its report was delivered)
    await lab.swarm.registry.patch(b.id, { state: 'done' });
    const queued = await lab.swarm.tool(PARENT, 'merge_helper', { helper: b.id });
    assertEquals(queued[0], 200, JSON.stringify(queued[1]));
    await lab.swarm.poll();
    const branch = lab.swarm.registry.get(b.id)!.worktree.branch;
    await until('the landable branch', async () => (await env.git(repo, 'branch', '--list', `${branch}-landable`)).includes('landable'));
    assertEquals(await env.git(repo, 'show', 'main:other.txt'), 'main other line', 'nothing landed');
    assertEquals(await env.git(repo, 'show', `${branch}-landable:other.txt`), 'helper b line', "a clean branch of the helper's own change");
    assertEquals(lab.swarm.registry.get(b.id)!.state, 'done');
    assert(lab.steers().some((t) => t.includes('conflicts') && t.includes('other.txt')), `told: ${lab.steers().join(' | ')}`);
  });
}

/**
 * Stop keeps the work on the helper's branch; the stopped helper's work is unlanded work the main agent can list, diff, land or
 * discard (kept on a studio/discarded branch).
 */
export async function stopAndUnlandedWork(env: Env): Promise<void> {
  await withLab(env, async (lab, repo) => {
    const a = await lab.start({ title: 'A', owns: ['src/a/**'] });
    await env.write(a.linux, 'src/a/x.txt', 'half done\n'); // never committed
    const stopped = await lab.swarm.tool(PARENT, 'stop_helper', { helper: a.id, reason: 'plans changed' });
    assertEquals(stopped[0], 200, JSON.stringify(stopped[1]));
    assertEquals((stopped[1] as { kept: Json[] }).kept.map((k) => k.commits), [1], 'the uncommitted file was committed on its branch');
    const h = lab.swarm.registry.get(a.id)!;
    assertEquals(h.state, 'stopped');
    assertEquals(await env.git(repo, 'log', '-1', '--format=%s', h.worktree.branch), 'AIB: helper stopped, work kept');
    lab.close(a.chat);

    // the main agent is handed it, and diffs it
    lab.swarm.handoffOrphanS = 0;
    await lab.swarm.poll();
    await lab.swarm.poll();
    const listed = await lab.swarm.unlandedWork(lab.caller(), { action: 'list' }) as { items: Json[] };
    assertEquals(listed.items.map((i) => i.work), [a.id], JSON.stringify(listed));
    const diff = await lab.swarm.unlandedWork(lab.caller(), { action: 'diff', work: a.id });
    assertEquals(diff.files, ['src/a/x.txt']);
    assert(String(diff.patch).includes('half done'), String(diff.patch));
    assertEquals(diff.branch, h.worktree.branch);

    // another one is landed by the main agent
    const b = await lab.start({ title: 'B', owns: ['src/b/**'] });
    await env.write(b.linux, 'src/b/y.txt', 'b work\n');
    await lab.swarm.tool(PARENT, 'stop_helper', { helper: b.id });
    lab.close(b.chat);
    const landed = await lab.swarm.unlandedWork(lab.caller(), { action: 'land', work: b.id });
    assert(['queued', 'merged'].includes(String(landed.state)), JSON.stringify(landed));
    await lab.swarm.poll();
    await until('B landed', () => lab.swarm.registry.get(b.id)?.state === 'merged');
    assertEquals(await env.git(repo, 'show', 'main:src/b/y.txt'), 'b work');

    // and A is discarded with a reason: kept on a branch, its copy removed
    const discarded = await lab.swarm.unlandedWork(lab.caller(), { action: 'discard', work: a.id, reason: 'not needed' });
    assertEquals(discarded.state, 'discarded', JSON.stringify(discarded));
    const kept = String(discarded.branch);
    assert(kept.startsWith('studio/discarded/'), kept);
    assertEquals(await env.git(repo, 'show', `${kept}:src/a/x.txt`), 'half done');
    await until('its copy removed', async () => !(await env.exists(a.linux)));
    assertEquals(lab.swarm.registry.get(a.id)!.state, 'discarded');
    assertEquals(await env.git(repo, 'ls-tree', '--name-only', 'main', 'src/a/'), '', 'discarded work did not land');
  });
}

/** Two helpers that end together land one after the other (one landing at a time in the folder), both land, nothing is lost. */
export async function twoHelpersOneFolder(env: Env): Promise<void> {
  await withLab(env, async (lab, repo) => {
    const a = await lab.start({ title: 'A', owns: ['src/a/**'] });
    const b = await lab.start({ title: 'B', owns: ['src/b/**'] });
    await commitIn(env, a.linux, 'src/a/a.txt', 'a\n', 'a work');
    await commitIn(env, b.linux, 'src/b/b.txt', 'b\n', 'b work');
    lab.endTurn(a.chat);
    lab.endTurn(b.chat);
    await Promise.all([lab.swarm.poll(), lab.swarm.poll()]);
    await lab.swarm.poll();
    await until('both landed', () => ['a', 'b'].every((x) => lab.swarm.registry.get(x === 'a' ? a.id : b.id)?.state === 'merged'));
    assertEquals(await env.git(repo, 'show', 'main:src/a/a.txt'), 'a');
    assertEquals(await env.git(repo, 'show', 'main:src/b/b.txt'), 'b');
    assertEquals(await env.git(repo, 'rev-list', '--count', 'main'), '3', 'the first commit and one landing each');
    // Undo of one (the page's button): the other stays
    const undone = await lab.swarm.undo(a.id);
    assertEquals((undone[1] as Json).state, 'undone', JSON.stringify(undone[1]));
    assertEquals((await env.git(repo, 'ls-tree', '-r', '--name-only', 'main')).split('\n').includes('src/a/a.txt'), false);
    assertEquals(await env.git(repo, 'show', 'main:src/b/b.txt'), 'b');
    const again = await lab.swarm.mergeAgain(a.id);
    assertEquals((again[1] as Json).state, 'merged', JSON.stringify(again[1]));
    assertEquals(await env.git(repo, 'show', 'main:src/a/a.txt'), 'a');
    assertEquals(Object.keys(readHelpers(lab.dir)).length, 2);
  });
}
