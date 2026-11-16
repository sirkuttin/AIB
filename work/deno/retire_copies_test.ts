/**
 * Build plan 1b, phase P4b (private/designs/worktree-model/build-plan-1b.md 5.3; e2e 16c, MF 5), after the owner's decisions of
 * 2026-11-16: every chat works in the project folder; helpers keep copies, which go once merged and closed (or 7 days after they
 * stopped); an OLD main chat's copy (from before folder chats) is left alone by the app: Merge and Discard work on it as before, and
 * the owner's one-off migration script (work/migrate/folder_chats_migrate.ts, tested in folder_chats_migrate_test.ts) moves those
 * chats to the project folder. The app only reads the script's moved-chat mapping (server/state/moved_chats.ts).
 *
 * Through a real Studio with fake agents and real git in temp folders. "Old copy chats" are made the way they exist after the
 * update: a worktree record with a saved session, continued through Studio.connect.
 */
import { assert, assertEquals } from './_assert.ts';
import { PYTHON, pause } from './_connection.ts';
import { FAKE } from './_connection.ts';
import { makeRepo, read, runGit, write } from './_worktree_fixtures.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import * as merge from '../../outputs/agent-studio/server/worktrees/merge.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { MOVED_FILE, readMoved } from '../../outputs/agent-studio/server/state/moved_chats.ts';
import { claudeEncode } from '../migrate/refile_core.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py');
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const lower = (p: string) => Deno.realPathSync(p).toLowerCase();

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-refile-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly claude = pathOf(this.dir, 'claude-config', 'projects');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly studio: Studio;
  #n = 0;

  constructor() {
    Deno.mkdirSync(this.claude, { recursive: true });
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0 }, { keeper: null });
    studio.ownerProbe = () => null;
    studio.agentLaunch = () => Promise.resolve([['unused'], {}]);
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const env = { ...(options?.env ?? {}), FAKE_ACP_LOG: pathOf(this.dir, `agent-${++this.#n}.log`) };
      return new Connection([PYTHON, UNIQUE, '--models'], cwd, provider, { ...(options ?? {}), env });
    };
    this.studio = studio;
  }

  /** An existing worktree chat (made before the update): its copy, record and saved session. */
  async existing(sessionId: string, kind: 'chat' | 'helper' = 'chat'): Promise<{ key: string; path: string; branch: string }> {
    const manager = new wt.Manager(this.state);
    const { plan } = await manager.planWithReason(this.project, crypto.randomUUID().replaceAll('-', ''), kind);
    assert(plan, 'a plan');
    await manager.create(plan);
    await manager.setSession(plan.key, 'claude', sessionId);
    return { key: plan.key, path: plan.path, branch: plan.branch };
  }

  /** Claude Code's transcript of a chat that worked in `cwd` (as the agent writes it: under projects/<enc cwd>/), plus a side folder. */
  transcript(sessionId: string, cwd: string, extra = ''): string {
    const folder = pathOf(this.claude, claudeEncode(cwd));
    Deno.mkdirSync(pathOf(folder, sessionId, 'subagents'), { recursive: true });
    Deno.writeTextFileSync(pathOf(folder, sessionId, 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n');
    const line = (n: number) => JSON.stringify({ type: 'user', cwd, sessionId, message: { role: 'user', content: `hello ${n} ${extra}` } });
    const file = pathOf(folder, `${sessionId}.jsonl`);
    Deno.writeTextFileSync(file, [line(1), JSON.stringify({ type: 'summary', summary: 'x' }), line(2)].join('\n') + '\n');
    return file;
  }

  mergeStudio(): merge.MergeStudio {
    const studio = this.studio;
    return { stateDir: this.state, liveState: (id) => studio.liveState(id, 0), liveCall: (op, body) => studio.liveCall(op, body as Json) };
  }

  async [Symbol.asyncDispose](): Promise<void> {
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

const studioRefs = (project: string, branch: string) =>
  runGit(project, 'for-each-ref', '--format=%(refname)', `refs/studio/${branch.slice('studio/'.length)}/`).trim();

// ---- through Studio --------------------------------------------------------------------------------------------------------
Deno.test({
  ...T,
  name: "an old copy chat, merged and closed, keeps its copy (the migration script's job, not the app's); its transcript is not " +
    'moved and Continue opens the copy',
  async fn() {
    await using box = new Box();
    const made = await box.existing('sess-merge');
    const original = box.transcript('sess-merge', made.path, 'merged');
    const c = await box.studio.connect('claude', made.path, 'sess-merge');
    assert(c.worktree, 'an existing worktree chat keeps its copy');
    write(c.cwd, 'from-copy.txt', 'copy work\n');
    const result = await merge.merge(box.mergeStudio(), c.id, 'copy work');
    assertEquals(result.state, 'merged', JSON.stringify(result));
    assertEquals(read(box.project, 'from-copy.txt'), 'copy work\n');
    await box.studio.liveCall('disconnect', { id: c.id });
    assertEquals(await box.studio.retireMerged(), [], 'a main chat copy is never retired by the app');
    assert(exists(made.path) && exists(original), 'the copy and the transcript stay');
    assertEquals(runGit(box.project, 'branch', '--list', made.branch).trim().replace(/^[*+ ]+/, ''), made.branch, 'its branch stays');
    assertEquals(readMoved(box.state), {}, 'the app writes no moved-chat mapping');
    assert(!exists(pathOf(box.state, MOVED_FILE)));
    const again = await box.studio.connect('claude', made.path, 'sess-merge');
    assertEquals(lower(again.cwd), lower(made.path), 'continues in its copy');
  },
});

Deno.test({
  ...T,
  name: 'P4b: a merged copy with new work after the merge is kept when its chat closes (unmerged work is never removed silently)',
  async fn() {
    await using box = new Box();
    const made = await box.existing('sess-more');
    const c = await box.studio.connect('claude', made.path, 'sess-more');
    write(c.cwd, 'a.txt', 'a\n');
    assertEquals((await merge.merge(box.mergeStudio(), c.id, 'a')).state, 'merged');
    write(c.cwd, 'b.txt', 'later work\n');
    await box.studio.liveCall('disconnect', { id: c.id });
    assertEquals(await box.studio.retireMerged(), []);
    assert(exists(made.path) && read(made.path, 'b.txt') === 'later work\n', 'the copy and its new work stay');
  },
});

Deno.test({
  ...T,
  name: "e2e 16c: a merged helper's copy is kept while its chat is open and removed after close; its transcript is never moved",
  async fn() {
    await using box = new Box();
    const made = await box.existing('sess-helper', 'helper');
    assert(made.branch.startsWith('studio/helper-'));
    const original = box.transcript('sess-helper', made.path);
    const c = await box.studio.connect('claude', made.path, 'sess-helper');
    write(c.cwd, 'h.txt', 'helper work\n');
    assertEquals((await merge.merge(box.mergeStudio(), c.id, 'helper work')).state, 'merged');
    assertEquals(await box.studio.retireMerged(), [], 'open: kept (MF 5)');
    assert(exists(made.path));
    await box.studio.liveCall('disconnect', { id: c.id });
    await box.studio.retireMerged();
    assert(!exists(made.path), 'removed after close');
    assertEquals(runGit(box.project, 'branch', '--list', made.branch).trim(), '');
    assertEquals(studioRefs(box.project, made.branch), '');
    assert(exists(original), 'a helper transcript is never moved');
  },
});

Deno.test({
  ...T,
  name: 'An old copy chat whose copy was discarded (before 2026-11-16 by the Discard button, now only by the migration script): ' +
    'the transcript is left alone; readable, not continuable; ' +
    "once the migration script mapped it (studio-moved-chats.json), Continue with the copy path opens the project folder",
  async fn() {
    await using box = new Box();
    const made = await box.existing('sess-discard');
    const original = box.transcript('sess-discard', made.path);
    const before = Deno.readTextFileSync(original);
    const c = await box.studio.connect('claude', made.path, 'sess-discard');
    write(c.cwd, 'unwanted.txt', 'thrown away\n');
    // the app has no Discard any more (owner, 2026-11-16): the copy goes the way the migration script's --discard removes it
    await box.studio.liveCall('disconnect', { id: c.id });
    assertEquals(await new wt.Manager(box.state).remove(made.key, true), 'removed');
    assert(!exists(made.path));
    assertEquals(studioRefs(box.project, made.branch), '');
    assert(!exists(pathOf(box.project, 'unwanted.txt')), 'discarded work does not land');
    assertEquals(Deno.readTextFileSync(original), before, 'the transcript is not touched');
    assert(!exists(pathOf(box.state, 'refiled')), 'no backups made by the app');
    let gone = false;
    try {
      await box.studio.connect('claude', made.path, 'sess-discard');
    } catch (error) {
      gone = error instanceof wt.WorktreeGone;
    }
    assert(gone, 'a discarded copy chat is readable, not continuable');

    // what the migration script writes (read only in the app): the chat continues in the project folder
    Deno.writeTextFileSync(pathOf(box.state, MOVED_FILE), JSON.stringify({
      version: 1,
      chats: { 'claude:sess-discard': { project: box.project, from: made.path, why: 'migrated', at: 1, refiled: '', backup: '' } },
    }));
    const again = await box.studio.connect('claude', made.path, 'sess-discard');
    assertEquals(lower(again.cwd), lower(box.project), 'continues in the project folder');
    assertEquals(again.worktree, null);
  },
});

Deno.test({
  ...T,
  name: "MF 5: a stopped or failed helper's copy goes 7 days after it stopped, only when closed and with nothing unmerged",
  async fn() {
    const { Registry } = await import('../../outputs/agent-studio/server/swarm/registry.ts');
    const { STOPPED_HELPER_DAYS } = await import('../../outputs/agent-studio/server/host/studio.ts');
    assertEquals(STOPPED_HELPER_DAYS, 7);
    await using box = new Box();
    const registry = new Registry(box.state);
    const now = Date.now() / 1000, day = 86_400;
    const helper = async (id: string, sessionId: string, state: 'stopped' | 'failed' | 'done', endedAt?: number) => {
      const made = await box.existing(sessionId, 'helper');
      await registry.update(id, () => ({
        id,
        title: id,
        project: box.project,
        parent: { live: 'parent-live', lasting: 'claude:parent' },
        chat: { live: '', lasting: `claude:${sessionId}`, provider: 'claude', model: '', mode: '' },
        worktree: { path: made.path, branch: made.branch, base: 'main', start: '' },
        state,
        reason: '',
        createdAt: now - 30 * day,
        ...(endedAt ? { endedAt } : {}),
      } as never));
      return made;
    };
    const old = await helper('h_old', 'sess-old', 'stopped', now - 8 * day); // clean, 8 days: goes
    const failed = await helper('h_fail', 'sess-fail', 'failed', now - 9 * day); // clean, failed 9 days ago: goes
    const recent = await helper('h_new', 'sess-new', 'stopped', now - 2 * day); // 2 days: kept
    const busy = await helper('h_work', 'sess-work', 'stopped', now - 8 * day); // committed work kept by the stop: kept
    write(busy.path, 'kept.txt', 'work\n');
    runGit(busy.path, 'add', '-A');
    runGit(busy.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'AIB: helper stopped, work kept');
    const legacy = await helper('h_legacy', 'sess-legacy', 'stopped'); // stopped before this build: no stop time yet
    const done = await helper('h_done', 'sess-done', 'done', now - 20 * day); // not stopped: never by this rule
    const open = await helper('h_open', 'sess-open', 'stopped', now - 8 * day); // its chat is open: kept
    const c = await box.studio.connect('claude', open.path, 'sess-open');

    const removed = await box.studio.retireStoppedHelpers(now);
    assertEquals(removed.sort(), ['h_fail', 'h_old']);
    assert(!exists(old.path) && !exists(failed.path));
    assertEquals(runGit(box.project, 'branch', '--list', old.branch).trim(), '', 'its branch went with it');
    for (const kept of [recent, busy, legacy, done, open]) assert(exists(kept.path), kept.path);
    assertEquals(read(busy.path, 'kept.txt'), 'work\n');
    const stamped = Number((await registry.get('h_legacy'))?.endedAt);
    assert(Math.abs(stamped - now) < 1, 'a helper stopped before this build is counted from now');
    assert(exists(pathOf(box.state, 'cleanup.log')));

    // closing its chat runs the rule: the copy goes
    await box.studio.liveCall('disconnect', { id: c.id });
    for (let i = 0; i < 50 && exists(open.path); i++) await pause(200);
    assert(!exists(open.path), 'removed once its chat closed');
    // 8 days on: the legacy one goes too; the one with commits never does silently
    const later = await box.studio.retireStoppedHelpers(now + 8 * day);
    assertEquals(later.sort(), ['h_legacy', 'h_new']);
    assert(exists(busy.path) && exists(done.path));
  },
});
