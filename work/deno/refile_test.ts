/**
 * Build plan 1b, phases P4b and P5-refile (private/designs/worktree-model/build-plan-1b.md 4.3-4.6, 5.3; e2e 15', 16c, 19, 19b, 19c),
 * adapted to the owner's final decisions (2026-11-16): there is no per-chat Own copy; every chat works in the project folder; an
 * EXISTING worktree chat keeps its copy until it is merged or discarded, then carries on in the project folder with its transcript
 * re-filed there; helpers keep copies, which go once merged and closed; helper transcripts are never moved.
 *
 * Through a real Studio with fake agents and real git in temp folders. The Claude Code transcripts are placed in a temp projects/
 * folder (studio.agentHomes), never the owner's ~/.claude. "Existing worktree chats" are made the way they exist after the update: a
 * worktree record with a saved session, continued through Studio.connect (no Own copy option involved).
 * The real-CLI form (adapters + the stub model API) is work/test_refile_e2e.py.
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
import * as refile from '../../outputs/agent-studio/server/worktrees/refile.ts';

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
    studio.agentHomes = () => ({ claudeProjects: this.claude, codexHome: null });
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
    const folder = pathOf(this.claude, refile.claudeEncode(cwd));
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
const worktreeList = (project: string) => runGit(project, 'worktree', 'list', '--porcelain').toLowerCase();

// ---- refile.ts on its own -------------------------------------------------------------------------------------------------
Deno.test('refile: rewriteCwd changes only "cwd" fields that are the copy or under it (any case); other text is left as it is', () => {
  const w = Deno.build.os === 'windows' ? 'C:\\State\\worktrees\\abc\\chat-1' : '/state/worktrees/abc/chat-1';
  const p = Deno.build.os === 'windows' ? 'C:\\Repos\\shop' : '/repos/shop';
  const sub = Deno.build.os === 'windows' ? w.toUpperCase() + '\\src' : w + '/src';
  const text = [
    JSON.stringify({ cwd: w, note: w }),
    JSON.stringify({ cwd: sub }),
    JSON.stringify({ cwd: w + '-other' }),
    '{"cwd" : ' + JSON.stringify(w) + ', "x": 1}',
  ].join('\n');
  const [out, n] = refile.rewriteCwd(text, w, p);
  assertEquals(n, 3);
  const rows = out.split('\n');
  assertEquals(JSON.parse(rows[0]), { cwd: p, note: w }, 'only cwd changes');
  assertEquals(JSON.parse(rows[1]).cwd, p + (Deno.build.os === 'windows' ? '\\src' : '/src'));
  assertEquals(JSON.parse(rows[2]).cwd, w + '-other', 'a sibling folder is not the copy');
  assert(rows[3].startsWith('{"cwd" : '), 'spacing kept');
  assertEquals(JSON.parse(rows[3]).cwd, p);
});

Deno.test('refile: refileClaude moves file + side folder, rewrites cwd, keeps a backup; a clash at the target changes nothing', () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-refile-unit-' }));
  try {
    const root = pathOf(dir, 'projects'), state = pathOf(dir, 'state');
    const w = pathOf(dir, 'state', 'worktrees', 'h', 'chat-1'), p = pathOf(dir, 'proj');
    const from = pathOf(root, refile.claudeEncode(w));
    Deno.mkdirSync(pathOf(from, 's1', 'tool-results'), { recursive: true });
    Deno.mkdirSync(pathOf(from, 'memory'), { recursive: true });
    Deno.writeTextFileSync(pathOf(from, 'memory', 'MEMORY.md'), 'notes');
    const original = JSON.stringify({ cwd: w, sessionId: 's1' }) + '\n';
    Deno.writeTextFileSync(pathOf(from, 's1.jsonl'), original);
    const done = refile.refileClaude({ stateDir: state, projectsRoot: root, sessionId: 's1', from: w, to: p });
    assertEquals(done.outcome, 'moved', done.message);
    const dest = pathOf(root, refile.claudeEncode(p), 's1.jsonl');
    assertEquals(done.path, dest);
    assertEquals(JSON.parse(Deno.readTextFileSync(dest)).cwd, p);
    assert(exists(pathOf(root, refile.claudeEncode(p), 's1', 'tool-results')), 'the side folder moved');
    assert(!exists(pathOf(from, 's1.jsonl')) && !exists(pathOf(from, 's1')), 'nothing left at the old place');
    assertEquals(Deno.readTextFileSync(pathOf(from, 'memory', 'MEMORY.md')), 'notes', 'memory/ stays');
    assertEquals(Deno.readTextFileSync(done.backup), original, 'the untouched original is backed up');
    assert(done.backup.startsWith(pathOf(state, 'refiled', 'claude')));
    assertEquals(refile.refileClaude({ stateDir: state, projectsRoot: root, sessionId: 's1', from: w, to: p }).outcome, 'already');

    // a transcript with the same id already filed under the project: nothing moves, nothing is deleted
    Deno.writeTextFileSync(pathOf(from, 's2.jsonl'), original);
    Deno.writeTextFileSync(pathOf(root, refile.claudeEncode(p), 's2.jsonl'), 'theirs\n');
    const clash = refile.refileClaude({ stateDir: state, projectsRoot: root, sessionId: 's2', from: w, to: p });
    assertEquals(clash.outcome, 'exists');
    assertEquals(Deno.readTextFileSync(pathOf(from, 's2.jsonl')), original);
    assertEquals(Deno.readTextFileSync(pathOf(root, refile.claudeEncode(p), 's2.jsonl')), 'theirs\n');
    assertEquals(refile.refileClaude({ stateDir: state, projectsRoot: root, sessionId: '../x', from: w, to: p }).outcome, 'refused');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('e2e 19b: only completely empty copy-named folders go (plain rmdir); memory/ or any file keeps one; others never touched', () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-refile-unit-' }));
  try {
    const root = pathOf(dir, 'projects'), wtRoot = pathOf(dir, 'state', 'worktrees');
    const enc = (p: string) => pathOf(root, refile.claudeEncode(p));
    const empty = enc(pathOf(wtRoot, 'h', 'chat-1'));
    const withMemory = enc(pathOf(wtRoot, 'h', 'chat-2'));
    const withTranscript = enc(pathOf(wtRoot, 'h', 'chat-3'));
    const otherEmpty = enc(pathOf(dir, 'elsewhere'));
    for (const d of [empty, pathOf(withMemory, 'memory'), withTranscript, otherEmpty]) Deno.mkdirSync(d, { recursive: true });
    Deno.writeTextFileSync(pathOf(withTranscript, 'x.jsonl'), '{}\n');
    const [removed, kept] = refile.cleanEmptyCopyFolders(root, wtRoot);
    assertEquals(removed, [empty]);
    assertEquals(kept.sort(), [withMemory, withTranscript].sort());
    assert(exists(otherEmpty), 'not a copy of this install: never touched');
    assertEquals(Deno.readTextFileSync(pathOf(withTranscript, 'x.jsonl')), '{}\n', 'no .jsonl is ever deleted');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('WSL helper (protocol 3): transcripts.refile moves a copy chat under the project in the distro; cleanEmpty sweeps; outside the root refused', async () => {
  const { refileMethods } = await import('../../outputs/agent-studio/server/wsl/helper/refile.ts');
  const { HELPER_PROTOCOL } = await import('../../outputs/agent-studio/server/wsl/contract.ts');
  assertEquals(HELPER_PROTOCOL, 3);
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-refile-wsl-' }));
  try {
    // the distro stand-in: <data> (backups, worktrees root), the user's ~/.claude and ~/.codex (named, as AIB names them under test)
    const data = pathOf(dir, 'data'), claudeDir = pathOf(dir, 'home', '.claude'), codexDir = pathOf(dir, 'home', '.codex');
    const root = pathOf(claudeDir, 'projects');
    const w = pathOf(data, 'worktrees', 'h1', 'chat-abcd1234'), p = pathOf(dir, 'proj');
    const ctx = { env: () => Promise.resolve({ env: {}, shell: '/bin/bash', home: pathOf(dir, 'nobody'), arch: 'x86_64' }) };
    const m = refileMethods(ctx, data);
    const from = pathOf(root, refile.claudeEncode(w));
    Deno.mkdirSync(from, { recursive: true });
    const original = JSON.stringify({ cwd: w, sessionId: 's1' }) + '\n';
    Deno.writeTextFileSync(pathOf(from, 's1.jsonl'), original);
    const done = (await m['transcripts.refile']({ provider: 'claude', sessionId: 's1', from: w, to: p, claudeDir })) as refile.RefileResult;
    assertEquals(done.outcome, 'moved', done.message);
    const dest = pathOf(root, refile.claudeEncode(p), 's1.jsonl');
    assertEquals(JSON.parse(Deno.readTextFileSync(dest)).cwd, p);
    assertEquals(Deno.readTextFileSync(done.backup), original, 'backed up in <data>/refiled/claude');
    assert(done.backup.startsWith(pathOf(data, 'refiled', 'claude')));
    assert(!exists(from), 'the emptied copy-named folder went (plain rmdir)');
    // a copy-named folder holding memory/ is kept by the sweep; an empty one goes
    const keptDir = pathOf(root, refile.claudeEncode(pathOf(data, 'worktrees', 'h1', 'chat-2')));
    const emptyDir = pathOf(root, refile.claudeEncode(pathOf(data, 'worktrees', 'h1', 'chat-3')));
    Deno.mkdirSync(pathOf(keptDir, 'memory'), { recursive: true });
    Deno.mkdirSync(emptyDir, { recursive: true });
    const swept = (await m['transcripts.cleanEmpty']({ claudeDir })) as { removed: string[]; kept: string[] };
    assertEquals([swept.removed, swept.kept], [[emptyDir], [keptDir]]);
    // Codex: only the backup here ('saved'); the rollout itself is never written
    const day = pathOf(codexDir, 'sessions', '2026', '11', '16');
    Deno.mkdirSync(day, { recursive: true });
    Deno.writeTextFileSync(pathOf(day, 'rollout-2026-11-16T00-00-00-c1.jsonl'), '{"x":1}\n');
    const saved = (await m['transcripts.refile']({ provider: 'codex', sessionId: 'c1', from: w, to: p, codexDir })) as refile.RefileResult;
    assertEquals(saved.outcome, 'saved');
    assertEquals(Deno.readTextFileSync(saved.backup), '{"x":1}\n');
    assertEquals(Deno.readTextFileSync(pathOf(day, 'rollout-2026-11-16T00-00-00-c1.jsonl')), '{"x":1}\n');
    // nothing on the channel can move another folder's transcript, or file one into the worktrees root
    for (const bad of [{ from: p, to: w }, { from: w, to: pathOf(data, 'worktrees', 'x') }, { from: 'relative', to: p }]) {
      let refused = false;
      try {
        await m['transcripts.refile']({ provider: 'claude', sessionId: 's1', claudeDir, ...bad });
      } catch {
        refused = true;
      }
      assert(refused, JSON.stringify(bad));
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ---- through Studio --------------------------------------------------------------------------------------------------------
Deno.test({
  ...T,
  name: "e2e 15': an existing worktree chat, merged, keeps its copy while open; closed: copy, branch, refs and record go, " +
    'its transcript is re-filed under the project, and Continue (even with the copy path) opens it in the project folder',
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
    assert(new wt.Registry(box.state).get(made.key)?.mergedAt, 'the record knows it was merged');

    assertEquals(await box.studio.retireMerged(), [], 'open: nothing is removed');
    assert(exists(made.path) && exists(original), 'the copy and transcript stay while the chat is open');

    await box.studio.liveCall('disconnect', { id: c.id }); // closing the chat starts the removal
    await box.studio.retireMerged(); // waits for the run the close started
    assert(!exists(made.path), 'the copy is gone');
    assertEquals(runGit(box.project, 'branch', '--list', made.branch).trim(), '', 'its branch is gone');
    assertEquals(studioRefs(box.project, made.branch), '', 'refs/studio/<slug>/* are gone');
    assert(!worktreeList(box.project).includes(made.path.toLowerCase().replaceAll('\\', '/')), "git's worktree record is gone");
    assertEquals(new wt.Registry(box.state).get(made.key), undefined, 'the record is gone');

    const filed = pathOf(box.claude, refile.claudeEncode(box.project), 'sess-merge.jsonl');
    assert(exists(filed), 'filed under the project folder');
    assert(!exists(original), 'not left under the copy');
    for (const line of Deno.readTextFileSync(filed).trim().split('\n')) {
      const row = JSON.parse(line);
      if (row.cwd) assertEquals(row.cwd, box.project, 'every cwd is the project');
    }
    assert(exists(pathOf(box.claude, refile.claudeEncode(box.project), 'sess-merge', 'subagents', 'agent-1.jsonl')), 'side folder moved');
    assert(!exists(pathOf(box.claude, refile.claudeEncode(made.path))), 'the empty copy-named folder is removed');
    const moved = refile.readMoved(box.state)['claude:sess-merge'];
    assertEquals(moved?.project, box.project);
    assertEquals(moved?.why, 'merged');
    assert(moved && exists(moved.backup), 'the backup exists');

    // Continue from a page that still sends the copy path: the project folder, as a folder chat
    const again = await box.studio.connect('claude', made.path, 'sess-merge');
    assertEquals(lower(again.cwd), lower(box.project), 'continues in the project folder');
    assertEquals(again.worktree, null, 'no copy any more');
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
    assertEquals(refile.readMoved(box.state)['claude:sess-more'], undefined, 'not moved to the folder');
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
    assertEquals(refile.readMoved(box.state)['claude:sess-helper'], undefined, 'a helper does not move to the folder');
  },
});

Deno.test({
  ...T,
  name: 'e2e 19: Discard of an existing worktree chat removes copy, branch and refs, re-files the transcript, keeps a backup, ' +
    'and answers movedToFolder; Continue then opens it in the project folder',
  async fn() {
    await using box = new Box();
    const made = await box.existing('sess-discard');
    const original = box.transcript('sess-discard', made.path);
    const before = Deno.readTextFileSync(original);
    const c = await box.studio.connect('claude', made.path, 'sess-discard');
    write(c.cwd, 'unwanted.txt', 'thrown away\n');
    const [status, out] = await box.studio.liveCall('worktree-discard', { id: c.id, confirm: true });
    assertEquals(status, 200, JSON.stringify(out));
    const answer = out as Json;
    assertEquals(answer.removed, true);
    assertEquals(lower(String(answer.movedToFolder)), lower(box.project));
    assert(!exists(made.path));
    assertEquals(studioRefs(box.project, made.branch), '');
    assert(!exists(pathOf(box.project, 'unwanted.txt')), 'discarded work does not land');
    const filed = pathOf(box.claude, refile.claudeEncode(box.project), 'sess-discard.jsonl');
    assert(exists(filed) && !exists(original));
    const moved = refile.readMoved(box.state)['claude:sess-discard'];
    assertEquals(moved.why, 'discarded');
    assertEquals(Deno.readTextFileSync(moved.backup), before, 'the backup is the untouched original');
    const again = await box.studio.connect('claude', made.path, 'sess-discard');
    assertEquals(lower(again.cwd), lower(box.project), 'a discarded chat continues in the project folder');
  },
});

Deno.test({
  ...T,
  name: 'e2e 19c: the one-time pass re-files old copy chats whose copies are gone, skips one still running and helpers, removes ' +
    'empty copy-named folders, and runs again at the next start while one was skipped',
  async fn() {
    await using box = new Box();
    const manager = new wt.Manager(box.state);
    // three old copy chats whose copies are already gone (removed-notes): a plain chat, a helper, one still running in AIB
    const old = await box.existing('sess-old');
    const helper = await box.existing('sess-old-helper', 'helper');
    const running = await box.existing('sess-running');
    const oldFile = box.transcript('sess-old', old.path);
    const helperFile = box.transcript('sess-old-helper', helper.path);
    const runningFile = box.transcript('sess-running', running.path);
    for (const m of [old, helper, running]) assertEquals(await manager.remove(m.key, true), 'removed');
    const emptyCopyFolder = pathOf(box.claude, refile.claudeEncode(pathOf(new wt.Registry(box.state).root, 'x', 'chat-gone')));
    Deno.mkdirSync(emptyCopyFolder, { recursive: true });
    // sess-running: open in AIB right now (it continues in the project folder; its transcript must not move under it)
    const live = await box.studio.connect('claude', box.project, null);
    (live as unknown as { sessionId: string }).sessionId = 'sess-running';

    const first = await box.studio.refilePass();
    assert(first);
    assertEquals(first.moved, ['claude:sess-old']);
    assertEquals(first.skipped.sort(), ['claude:sess-old-helper', 'claude:sess-running'].sort());
    assert(exists(pathOf(box.claude, refile.claudeEncode(box.project), 'sess-old.jsonl')) && !exists(oldFile));
    assert(exists(helperFile), 'helper transcripts are never moved');
    assert(exists(runningFile), 'a running chat is never re-filed');
    assert(!exists(emptyCopyFolder), 'an empty copy-named folder is removed');
    assert(!exists(pathOf(box.state, 'refile-once.json')), 'one was skipped as running: the pass runs again next time');

    await live.close();
    const second = await box.studio.refilePass();
    assertEquals(second?.moved, ['claude:sess-running']);
    assert(exists(pathOf(box.state, 'refile-once.json')));
    assert(exists(helperFile), 'still never moved');
    assertEquals((await box.studio.refilePass())?.moved, [], 'once done, the orphan part does not run again');
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
