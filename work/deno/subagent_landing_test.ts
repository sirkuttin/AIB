/**
 * Subagent worktrees P2 (landing), without a real agent: a real AIB with the fake agent as the parent chat, subagent records and
 * worktrees made the way subagents/service.ts makes them, and the web process's swarm landing (swarm/service.ts). The real Claude
 * adapter end to end is work/test_subagent_landing_e2e.py.
 *   a done subagent lands when its parent is idle: one "AIB: subagent <description>" commit on the folder's branch, its file only
 *       (never the folder's uncommitted edit), the "Merged subagent" line with Undo, its worktree, branch and record gone, and a
 *       junction inside it (an `npm link`) removed without emptying its target (P0b R11, security review MF 6)
 *   B8  crash mid-landing: the journal finishes a landing whose branch already moved ("finished after a restart"), and puts one
 *       whose branch did not move back in the queue, which then lands
 *   a stopped subagent never lands by itself; merge_helper with its id lands it
 *   ownSubagentPath (security review SF 9): only <root>\<repo hash>\sub-*, never the hash folder, never outside the root
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, pause, PYTHON, until } from './_connection.ts';
import { makeRepo, read, runGit, write } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { LANDING_BUSY_WAKE_S, LANDING_DIRTY_RETRY_S, LANDING_REMIND_S, Swarm } from '../../app/server/swarm/service.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { landingWords, ownSubagentPath, readSubagents, type SubagentRecord } from '../../app/server/subagents/service.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py');

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-sub-landing-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly aib: Aib;
  swarm: Swarm;
  n = 0;

  constructor() {
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    runGit(this.project, 'config', 'core.autocrlf', 'false');
    const aib = new Aib({ stateDir: this.state, port: 0 }, { keeper: null });
    aib.ownerProbe = () => null;
    aib.agentLaunch = () => Promise.resolve([['unused'], {}]);
    aib.connectionFactory = (_command, cwd, provider, options) =>
      new Connection([PYTHON, UNIQUE, '--models'], cwd, provider, { ...(options ?? {}), env: { ...(options?.env ?? {}), PYTHONUTF8: '1' } });
    this.aib = aib;
    this.swarm = this.newSwarm();
  }

  newSwarm(): Swarm {
    return new Swarm({ stateDir: this.state, host: this.aib, settings: this.aib.settings });
  }

  /** A subagent's worktree and record as subagents/service.ts makes them (S = the folder's HEAD here), with `file` changed in it. */
  subagent(
    chat: string,
    file: string,
    body: string,
    state: 'done' | 'stopped' | 'running' = 'done',
    more: Partial<SubagentRecord> & { files?: Record<string, string>; commit?: boolean; seed?: boolean } = {},
  ): { id: string; path: string } {
    const n = ++this.n;
    const root = this.aib.subagents!.root;
    const hash = wt.repoHash(this.project);
    const slug = `sub-test${n}`;
    const path = pathOf(root, hash, slug);
    Deno.mkdirSync(pathOf(root, hash), { recursive: true });
    const s = more.seed ? this.snapshotOfFolder() : runGit(this.project, 'rev-parse', 'HEAD').trim();
    runGit(this.project, 'worktree', 'add', '-q', '-b', `studio/${slug}`, path, s);
    runGit(this.project, 'worktree', 'lock', '--reason', 'AIB subagent', path);
    const { files, commit, seed: _seed, ...fields } = more;
    if (file) write(path, file, body); // uncommitted, as a subagent leaves it
    for (const [name, text] of Object.entries(files ?? {})) write(path, name, text);
    if (commit) {
      runGit(path, 'add', '-A');
      runGit(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub work');
    }
    const id = `sa_test${n}`;
    const file2 = pathOf(this.state, 'subagent-worktrees.json');
    const all = readSubagents(this.state);
    all[id] = {
      id,
      kind: 'subagent',
      chat,
      lasting: '',
      project: this.project,
      folder: this.project,
      slug,
      branch: `studio/${slug}`,
      path,
      snapshot: s,
      tree: '',
      state,
      toolUseId: `toolu_${n}`,
      agentId: `agent${n}`,
      agentType: 'general-purpose',
      description: `sub ${n}`,
      createdAt: Date.now() / 1000,
      ...(state === 'done' ? { doneAt: Date.now() / 1000 } : state === 'stopped' ? { stoppedAt: Date.now() / 1000, stoppedWhy: 'the turn was stopped' } : {}),
      ...fields,
    };
    Deno.writeTextFileSync(file2, JSON.stringify({ version: 1, subagents: all }));
    return { id, path };
  }

  /** S as subagents/service.ts makes it: HEAD plus the folder's uncommitted files (untracked ones too), as an "AIB snapshot" commit. */
  snapshotOfFolder(): string {
    const index = pathOf(this.dir, `snapshot-index-${++this.n}`);
    const run = (...args: string[]) => {
      const done = new Deno.Command('git', {
        args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        cwd: this.project,
        env: { GIT_INDEX_FILE: index },
        stdout: 'piped',
        stderr: 'piped',
      }).outputSync();
      assertEquals(done.code, 0, new TextDecoder().decode(done.stderr));
      return new TextDecoder().decode(done.stdout).trim();
    };
    run('read-tree', 'HEAD');
    run('add', '-A');
    return run('commit-tree', run('write-tree'), '-p', 'HEAD', '-m', 'AIB snapshot');
  }

  /** The subagent's state changed in the record file (a running one finishes). */
  setState(id: string, state: 'done' | 'running'): void {
    const all = readSubagents(this.state);
    all[id] = { ...all[id], state, ...(state === 'done' ? { doneAt: Date.now() / 1000 } : {}) };
    Deno.writeTextFileSync(pathOf(this.state, 'subagent-worktrees.json'), JSON.stringify({ version: 1, subagents: all }));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.swarm.stopWatching();
    await this.aib.close().catch(() => {});
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
const log = (project: string) => runGit(project, 'log', '--format=%s', '-n', '20');
const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

async function settle(c: Connection): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (c.busy && Date.now() < deadline) {
    for (const key of [...c.permissions.keys()]) c.permission(key, 'yes');
    await pause(50);
  }
  assert(!c.busy, 'the turn ended');
}

/** A turn of the fake agent that runs until the returned function is called. */
async function holdTurn(box: Box, c: Connection, name: string): Promise<() => Promise<void>> {
  const gate = pathOf(box.dir, `gate-${name}`);
  await c.prompt(`gate:${gate}`);
  assert(c.busy, 'the turn runs');
  return async () => {
    Deno.writeTextFileSync(gate, '');
    await until(() => !c.busy, 'the held turn ended', 15);
  };
}

Deno.test({
  ...T,
  name: 'a done subagent lands as one commit when its parent is idle; its worktree goes, a junction target inside survives',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    write(box.project, 'dirty.txt', 'main-edit\n'); // the main agent's uncommitted edit
    const target = pathOf(box.dir, 'linked-pkg');
    write(target, 'index.js', 'keep me\n');
    const { id, path } = box.subagent(main.id, 'sub.txt', 'from-sub\n');
    // An `npm link` in the subagent's worktree. git does not stage a Windows junction at all, but on Linux and macOS it is a symlink that
    // `git add -A` stages like any file; real projects ignore node_modules, so the test does too there.
    if (Deno.build.os !== 'windows') Deno.writeTextFileSync(pathOf(box.project, '.git', 'info', 'exclude'), 'node_modules\n', { append: true });
    Deno.symlinkSync(target, pathOf(path, 'node_modules'), { type: 'junction' });
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent sub 1'), 'landed', 15);
    assertEquals(runGit(box.project, 'show', '--name-only', '--format=', 'HEAD').trim(), 'sub.txt');
    assert(runGit(box.project, 'status', '--porcelain').includes('?? dirty.txt'), 'the main edit stays uncommitted');
    assert(notes(main).some((n) => n.startsWith('Merged subagent “sub 1” into main · 1 file')), notes(main).join('\n'));
    await until(() => !readSubagents(box.state)[id], 'its record released', 15);
    assert(!exists(path), 'its worktree is gone');
    assertEquals(runGit(box.project, 'branch', '--list', 'studio/sub-*').trim(), '');
    assertEquals(Deno.readTextFileSync(pathOf(target, 'index.js')), 'keep me\n', 'the junction target was emptied');
    assertEquals(runGit(box.project, 'stash', 'list').trim(), '');
    // Undo, from the page, as for a helper
    const [code] = await box.swarm.undo(id);
    assertEquals(code, 200);
    assert(!exists(pathOf(box.project, 'sub.txt')), 'undone');
  },
});

Deno.test({
  ...T,
  name: 'B8: a subagent landing cut off by a crash is finished (branch moved) or queued again and landed (not moved)',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    // the parent works: the landing is taken up (queued) but cannot run yet
    let release = await holdTurn(box, main, 'one');
    const a = box.subagent(main.id, 'a.txt', 'a\n');
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(a.id)?.landing?.stage, 'queued');
    // the crash: the branch had moved already (the journal said 'moved')
    const tip = runGit(box.project, 'rev-parse', 'main').trim();
    write(box.project, 'a.txt', 'a\n');
    runGit(box.project, 'add', 'a.txt');
    runGit(box.project, 'commit', '-q', '-m', 'AIB: subagent sub 1');
    const landed = runGit(box.project, 'rev-parse', 'main').trim();
    await box.swarm.registry.update(a.id, (h) => (h ? { ...h, landing: { ...h.landing!, stage: 'moved', landed, tipBefore: tip } } : null));
    await release();
    await box.swarm.stopWatching();
    box.swarm = box.newSwarm(); // a new web process: nothing here runs that landing
    await box.swarm.poll();
    const done = box.swarm.registry.get(a.id)!;
    assertEquals([done.state, done.landing ?? null, done.merge?.landed], ['merged', null, landed]);
    assert(notes(main).some((n) => n.startsWith('Merged subagent “sub 1”') && n.endsWith('finished after a restart')), notes(main).join('\n'));
    await until(() => !readSubagents(box.state)[a.id], 'its worktree released after recovery', 15);
    assert(!exists(a.path));

    // cut off before the branch moved ('built'): back in the queue, then landed when the parent is idle
    release = await holdTurn(box, main, 'two');
    const b = box.subagent(main.id, 'b.txt', 'b\n');
    await box.swarm.poll();
    await box.swarm.registry.update(b.id, (h) => (h ? { ...h, landing: { ...h.landing!, stage: 'built', landed: 'f'.repeat(40), tipBefore: landed } } : null));
    await release();
    await box.swarm.stopWatching();
    box.swarm = box.newSwarm();
    await box.swarm.poll();
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent sub 2'), 'landed after recovery', 15);
    assertEquals(runGit(box.project, 'show', '--name-only', '--format=', 'HEAD').trim(), 'b.txt');
  },
});

Deno.test({
  ...T,
  name: 'a stopped subagent never lands by itself; merge_helper with its id lands it',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const { id } = box.subagent(main.id, 'stopped.txt', 'half\n', 'stopped');
    await box.swarm.poll();
    await box.swarm.poll();
    assert(!log(box.project).includes('AIB: subagent sub 1'), 'a stopped subagent landed');
    assert(notes(main).some((n) => n.startsWith('Subagent “sub 1” was stopped before it finished')), notes(main).join('\n'));
    await settle(main); // the hand-over woke the chat (a turn): a landing waits for it to be idle
    const [code, out] = await box.swarm.tool(main.id, 'merge_helper', { helper: id }); // swarm off: still accepted for a subagent id
    assertEquals(code, 200, JSON.stringify(out));
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent sub 1'), 'landed on merge_helper', 15);
  },
});

/** The parent's next-prompt lines (prompt-context), as AIB collects them. */
function contextLines(box: Box): string[] {
  const lines: string[] = [];
  const own = box.aib.addPromptContext.bind(box.aib);
  box.aib.addPromptContext = (c, line, replace) => {
    lines.push(line);
    own(c, line, replace);
  };
  return lines;
}

/** The turns that wake the parent (swarm reports and failed landings go in through steer, or queue when the user stopped it). */
function wakes(box: Box): { op: string; text: string; id: string }[] {
  const out: { op: string; text: string; id: string }[] = [];
  const own = box.aib.liveCall.bind(box.aib);
  box.aib.liveCall = (name, body) => {
    if (name === 'steer' || name === 'queue') out.push({ op: name, text: String((body as Json).text), id: String((body as Json).clientMessageId) });
    return own(name, body);
  };
  return out;
}

Deno.test({
  ...T,
  name: 'scratch: a subagent that only left a page and a note at its worktree top lands nothing, keeps them and tells the parent; merge_helper lands them',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const told = contextLines(box);
    const { id, path } = box.subagent(main.id, 'inbox-v31-design.html', '<p>mockup</p>\n', 'done', {
      description: 'Inbox v3.1: design',
      files: { 'architect-review-v2.md': '# review\n' },
    });
    await box.swarm.poll();
    await until(() => told.some((l) => l.includes('Subagent “Inbox v3.1: design” left new files')), 'the parent told', 15);
    await box.swarm.poll();
    assert(!log(box.project).includes('AIB: subagent Inbox v3.1: design'), 'scratch files landed');
    assert(!exists(pathOf(box.project, 'inbox-v31-design.html')));
    assert(readSubagents(box.state)[id], 'its record is kept');
    assert(exists(pathOf(path, 'inbox-v31-design.html')) && exists(pathOf(path, 'architect-review-v2.md')), 'the files stay in its worktree');
    const line = told.find((l) => l.includes('left new files'))!;
    assert(line.includes('inbox-v31-design.html') && line.includes('architect-review-v2.md') && line.includes(path), line);
    assert(line.includes(`merge_helper with id ${id}`) && line.includes('in 7 days'), line);
    assert(notes(main).some((n) => n.startsWith('Didn\'t land subagent “Inbox v3.1: design”: it only left new files')), notes(main).join('\n'));
    // the main agent wants them after all
    const [code, out] = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals(code, 200, JSON.stringify(out));
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent Inbox v3.1: design'), 'landed on merge_helper', 15);
    assert(exists(pathOf(box.project, 'inbox-v31-design.html')));
    await until(() => !readSubagents(box.state)[id], 'released after landing', 15);
  },
});

Deno.test({
  ...T,
  name: 'scratch: real changes land without the root note (kept in the worktree, parent told); a committed root note and a .txt land as work',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const told = contextLines(box);
    const mixed = box.subagent(main.id, 'src/editor.js', 'export const x = 1;\n', 'done', {
      description: 'File editor spike',
      files: { 'file-editor-design-v2.md': '# design\n' },
    });
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent File editor spike'), 'its code landed', 15);
    assertEquals(runGit(box.project, 'show', '--name-only', '--format=', 'HEAD').trim(), 'src/editor.js');
    assert(!exists(pathOf(box.project, 'file-editor-design-v2.md')), 'the scratch note stayed out of the project');
    assert(exists(pathOf(mixed.path, 'file-editor-design-v2.md')) && readSubagents(box.state)[mixed.id], 'kept with its worktree');
    assert(told.some((l) => l.includes('landed in this folder') && l.includes('file-editor-design-v2.md')), told.join('\n'));
    assert(notes(main).some((n) => n.includes('1 new file kept in its worktree (file-editor-design-v2.md)')), notes(main).join('\n'));
    await box.swarm.poll();
    assert(exists(mixed.path), 'not released by a later poll while it keeps the file');
    // merge_helper: only the kept note lands now, then the worktree goes
    const [code] = await box.swarm.tool(main.id, 'merge_helper', { helper: mixed.id });
    assertEquals(code, 200);
    await box.swarm.poll();
    await until(() => exists(pathOf(box.project, 'file-editor-design-v2.md')), 'the note landed on merge_helper', 15);
    assertEquals(runGit(box.project, 'show', '--name-only', '--format=', 'HEAD').trim(), 'file-editor-design-v2.md');
    await until(() => !readSubagents(box.state)[mixed.id], 'released', 15);

    // a note the subagent committed, and a plain .txt, are its work: they land
    box.subagent(main.id, '', '', 'done', { description: 'committed note', files: { 'NOTES.md': 'kept\n' }, commit: true });
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent committed note'), 'a committed root note lands', 15);
    box.subagent(main.id, 'top.txt', 'x\n', 'done', { description: 'plain txt' });
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent plain txt'), 'a .txt lands', 15);
  },
});

Deno.test({
  ...T,
  name: 'ignored: a subagent whose only output is a git-ignored file keeps its worktree, the parent gets the path, it goes after 7 days',
  async fn() {
    await using box = new Box();
    write(box.project, '.gitignore', 'ignored.log\nbuild/\nnode_modules/\nprivate/\n');
    runGit(box.project, 'commit', '-q', '-am', 'ignore private');
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const told = contextLines(box);
    const { id, path } = box.subagent(main.id, 'private/release/beta12-release-notes-draft.md', '# Beta 12\n', 'done', {
      description: 'Release notes draft',
      files: { 'node_modules/pkg/index.js': 'x\n' }, // an install's folder never counts
    });
    await box.swarm.poll();
    await until(() => told.some((l) => l.includes('private/release/beta12-release-notes-draft.md')), 'the parent told the path', 15);
    const line = told.find((l) => l.includes('beta12-release-notes-draft.md'))!;
    assert(!line.includes('node_modules'), line);
    await box.swarm.poll();
    assert(exists(pathOf(path, 'private', 'release', 'beta12-release-notes-draft.md')), 'the draft was removed with its worktree');
    assert(readSubagents(box.state)[id], 'its record is kept (it can be resumed)');
    // seven days on: the worktree goes
    await box.swarm.registry.update(id, (h) => (h ? { ...h, sub: { ...h.sub!, keptAt: Date.now() / 1000 - 8 * 86400 } } : null));
    await box.swarm.poll();
    await until(() => !readSubagents(box.state)[id], 'released after the grace period', 15);
    assert(!exists(path));
  },
});

Deno.test({
  ...T,
  name: 'names: a queued landing takes the name its record was fixed to (parallel calls swapped back) before it lands',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const release = await holdTurn(box, main, 'names');
    const { id } = box.subagent(main.id, 'spike.js', 'x\n', 'done', { description: 'Inbox v3.1: design + toast research' });
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)?.landing?.stage, 'queued');
    const all = readSubagents(box.state); // AIB fixed the pairing (subagents/service.ts swapCalls)
    all[id] = { ...all[id], description: 'File editor: update design + spike' };
    Deno.writeTextFileSync(pathOf(box.state, 'subagent-worktrees.json'), JSON.stringify({ version: 1, subagents: all }));
    await box.swarm.poll();
    await release();
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent File editor: update design + spike'), 'landed under its own name', 15);
    assert(!log(box.project).includes('Inbox v3.1'), log(box.project));
  },
});

Deno.test({
  ...T,
  name: "restart: subagents of the chat's earlier live id (same conversation) are adopted and land once Claude Code's files say they finished",
  async fn() {
    await using box = new Box();
    const config = pathOf(box.dir, 'claude-config');
    const was = Deno.env.get('CLAUDE_CONFIG_DIR');
    Deno.env.set('CLAUDE_CONFIG_DIR', config);
    try {
      const main = await box.aib.connect('claude', box.project, null, {});
      await settle(main);
      assert(main.sessionId, 'the fake agent gives a session id');
      const lasting = `claude:${main.sessionId}`;
      // started under the chat's previous live id; that chat is gone (PC crash), its SubagentStop never reached AIB
      const a = box.subagent('c533d888old', 'inbox.js', 'x\n', 'running', { lasting, agentId: 'agentOld1', description: 'Build Inbox v3.1 phases 1-3' });
      const b = box.subagent('c533d888old', 'still.js', 'y\n', 'running', { lasting, agentId: 'agentOld2', description: 'still at work' });
      const dir = pathOf(config, 'projects', 'C--proj', main.sessionId!, 'subagents');
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(pathOf(dir, 'agent-agentOld1.meta.json'), JSON.stringify({ description: 'Build Inbox v3.1 phases 1-3', finished: true }));
      Deno.writeTextFileSync(pathOf(dir, 'agent-agentOld1.jsonl'), JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }) + '\n');
      Deno.writeTextFileSync(pathOf(dir, 'agent-agentOld2.meta.json'), JSON.stringify({ description: 'still at work' }));
      Deno.writeTextFileSync(pathOf(dir, 'agent-agentOld2.jsonl'), '{}\n');
      await main.prompt('next'); // the chat's next turn end adopts them (host/aib.ts turnEnded -> reconcileEnded)
      await settle(main);
      await until(() => readSubagents(box.state)[a.id]?.chat === main.id, 'adopted by the new chat', 15);
      assertEquals(readSubagents(box.state)[a.id].state, 'done');
      assertEquals([readSubagents(box.state)[b.id].chat, readSubagents(box.state)[b.id].state], [main.id, 'running']);
      await box.swarm.poll();
      await until(() => log(box.project).includes('AIB: subagent Build Inbox v3.1 phases 1-3'), 'landed', 15);
      await until(() => !readSubagents(box.state)[a.id], 'released: worktree, branch and record gone', 15);
      assert(!exists(a.path));
      assert(exists(b.path), 'the one still at work keeps its worktree');
    } finally {
      if (was === undefined) Deno.env.delete('CLAUDE_CONFIG_DIR');
      else Deno.env.set('CLAUDE_CONFIG_DIR', was);
    }
  },
});

Deno.test({
  ...T,
  name: 'a branch the main agent merged by hand is already landed: no conflict line, worktree and branch removed',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const told = contextLines(box);
    // committed in its worktree, then merged into main by hand, and main changed the same file again afterwards
    const a = box.subagent(main.id, 'shared.txt', 'sub version\n', 'done', { commit: true });
    runGit(box.project, 'merge', '-q', '--no-edit', 'studio/sub-test1');
    write(box.project, 'shared.txt', 'later main version\n');
    runGit(box.project, 'add', 'shared.txt');
    runGit(box.project, 'commit', '-q', '-m', 'main moves on');
    const before = runGit(box.project, 'rev-parse', 'main').trim();
    await box.swarm.poll();
    await until(() => !readSubagents(box.state)[a.id], 'the already merged subagent released', 15);
    assert(!exists(a.path), 'its worktree is gone');
    assertEquals(runGit(box.project, 'branch', '--list', 'studio/sub-*').trim(), '');
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), before, 'nothing new landed');
    assert(!notes(main).some((n) => n.includes('conflict')), notes(main).join('\n'));
    assert(!told.some((l) => l.includes('conflict') || l.includes('Redo')), told.join('\n'));
  },
});

Deno.test({
  ...T,
  name: 'a real conflict with main wakes the parent at once with a visible line, keeps the worktree and offers a clean branch',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const told = contextLines(box);
    const woke = wakes(box);
    const b = box.subagent(main.id, 'shared.txt', 'other sub version\n');
    write(box.project, 'shared.txt', 'main version\n');
    runGit(box.project, 'add', 'shared.txt');
    runGit(box.project, 'commit', '-q', '-m', 'main adds it differently');
    await box.swarm.poll();
    await until(() => notes(main).some((n) => n.includes("couldn't land")), 'conflict told', 15);
    assert(exists(b.path), 'the conflicting worktree is kept');
    assert(
      notes(main).includes("Builder 'sub 1' couldn't land: conflict in 1 file (shared.txt). The main agent is merging it by hand."),
      notes(main).join('\n'),
    );
    // the parent is woken now (a turn of its own), not at the owner's next message (no held next-prompt line)
    assertEquals(woke.length, 1, JSON.stringify(woke));
    assert(woke[0].op === 'steer' && woke[0].text.includes('did not land') && woke[0].text.includes('shared.txt'), woke[0].text);
    assert(woke[0].text.includes('studio/sub-test1-landable') && woke[0].text.includes('by hand'), woke[0].text);
    assert(!told.some((l) => l.includes('did not land')), told.join('\n'));
    // the clean branch: one commit on main's old HEAD with only the builder's change
    assertEquals(runGit(box.project, 'show', '--name-only', '--format=', 'studio/sub-test1-landable').trim(), 'shared.txt');
  },
});

for (const shape of ['fast-forward', 'merge commit']) {
  Deno.test({
    ...T,
    name: `a builder that took in an already landed builder's branch (${shape}) lands only its own changes, with no conflict`,
    async fn() {
      await using box = new Box();
      const main = await box.aib.connect('claude', box.project, null, {});
      await settle(main);
      const woke = wakes(box);
      const a = box.subagent(main.id, 'a.txt', 'from A\n', 'running', { commit: true, description: 'builder A' });
      const own = shape === 'merge commit'; // B has a commit of its own first, so taking in A's branch makes a merge commit
      const b = box.subagent(main.id, '', '', 'running', { description: 'builder B', ...(own ? { files: { 'b0.txt': 'B first\n' }, commit: true } : {}) });
      runGit(b.path, 'merge', '-q', '--no-edit', 'studio/sub-test1'); // B builds on A's branch
      assertEquals(runGit(b.path, 'rev-list', '--merges', '--count', 'HEAD').trim(), own ? '1' : '0');
      write(b.path, 'b.txt', 'from B\n');
      box.setState(a.id, 'done');
      await box.swarm.poll();
      await until(() => log(box.project).includes('AIB: subagent builder A'), 'A landed', 15);
      await until(() => !readSubagents(box.state)[a.id], 'A released: its branch is gone', 15);
      // the main agent changes A's file afterwards: the same change twice in different shapes
      write(box.project, 'a.txt', 'main edited A\n');
      runGit(box.project, 'commit', '-q', '-am', 'main edits a.txt');
      box.setState(b.id, 'done');
      await box.swarm.poll();
      await until(() => log(box.project).includes('AIB: subagent builder B') || notes(main).some((n) => n.includes('builder B')), 'B landed', 15);
      assert(log(box.project).includes('AIB: subagent builder B'), notes(main).join('\n'));
      const names = runGit(box.project, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter((n) => n).sort();
      assertEquals(names, own ? ['b.txt', 'b0.txt'] : ['b.txt']);
      assertEquals(read(box.project, 'a.txt'), 'main edited A\n');
      assertEquals(woke.length, 0, 'no failed landing');
      assert(!notes(main).some((n) => n.includes("couldn't land")), notes(main).join('\n'));
    },
  });
}

Deno.test({
  ...T,
  name: "a snapshot never lands the main folder's uncommitted files (untracked or edited) nor aib-shared content",
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    // B starts clean; then the owner writes a doc (untracked) and edits a tracked file; A starts from a snapshot that holds them
    const b = box.subagent(main.id, '', '', 'running', { description: 'builder B' });
    write(box.project, 'aib-docs/notes-things-to-fix/01-page-1.md', 'owner notes\n');
    write(box.project, 'tracked.txt', 'owner edit, uncommitted\n');
    box.subagent(main.id, 'a.txt', 'from A\n', 'running', { commit: true, seed: true, description: 'builder A' });
    runGit(b.path, 'merge', '-q', '--no-edit', 'studio/sub-test2'); // B builds on A's branch (A is not landed)
    write(b.path, 'b.txt', 'from B\n');
    write(b.path, 'aib-shared/shared-note.txt', 'shared\n'); // content of the main folder's shared folder, as seen through the link
    box.setState(b.id, 'done');
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent builder B'), 'B landed', 15);
    const landed = runGit(box.project, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter((n) => n).sort();
    assertEquals(landed, ['a.txt', 'b.txt']);
    const status = runGit(box.project, 'status', '--porcelain', '-uall');
    assert(status.includes('?? aib-docs/notes-things-to-fix/01-page-1.md') && status.includes(' M tracked.txt'), status);
    assertEquals(read(box.project, 'aib-docs/notes-things-to-fix/01-page-1.md'), 'owner notes\n');
    assertEquals(read(box.project, 'tracked.txt'), 'owner edit, uncommitted\n');
  },
});

Deno.test({
  ...T,
  name: "landing never overwrites an uncommitted main-folder file: the builder's change to it is refused, the file stays as it is",
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const woke = wakes(box);
    const a = box.subagent(main.id, 'notes.txt', 'builder version\n', 'done', { files: { 'other.txt': 'x\n' } });
    write(box.project, 'notes.txt', 'owner draft, untracked\n'); // after the worktree was made
    await box.swarm.poll();
    await until(() => notes(main).some((n) => n.includes('uncommitted edits')), 'refused and told', 15);
    assertEquals(read(box.project, 'notes.txt'), 'owner draft, untracked\n');
    assert(!log(box.project).includes('AIB: subagent'), log(box.project));
    assert(!exists(pathOf(box.project, 'other.txt')), 'nothing landed');
    assert(exists(a.path), 'its worktree is kept');
    // 2026-11-23: told only at the lead's next prompt, an idle lead never saw it: now it is woken, once, with the files named
    assertEquals(woke.length, 1, JSON.stringify(woke));
    assert(woke[0].op === 'steer' && woke[0].text.includes('uncommitted edits') && woke[0].text.includes('notes.txt'), woke[0].text);
    await box.swarm.poll();
    assertEquals(woke.length, 1, 'the same refusal is not told twice');
    assertEquals(landingWords(box.swarm.registry.get(a.id)!), "Didn't land: files it changed have uncommitted edits");
    // never waits forever: the owner sets the file aside; the next timed retry lands it without any turn end
    Deno.removeSync(pathOf(box.project, 'notes.txt'));
    const at = Date.now();
    box.swarm.clock = () => at + (LANDING_DIRTY_RETRY_S + 5) * 1000;
    await settle(main); // the wake was a turn of the parent's own: landing waits until it is over
    await box.swarm.poll();
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent sub 1'), 'landed by the timed retry '+ JSON.stringify(box.swarm.registry.get(a.id)?.landing), 15);
  },
});

Deno.test({
  ...T,
  name: '2026-11-23: a parent that stays busy keeps the landing queued: it says why, wakes the parent once, and lands when the parent is idle',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const woke = wakes(box);
    const release = await holdTurn(box, main, 'busy');
    const a = box.subagent(main.id, 'a.txt', 'a\n');
    await box.swarm.poll();
    await box.swarm.poll();
    const L = box.swarm.registry.get(a.id)!.landing!;
    assertEquals(L.stage, 'queued'); // the found state: queued, tries 0, no refusal ever recorded, no line
    assertEquals(woke.length, 0, 'a short wait says nothing');
    assert(landingWords(box.swarm.registry.get(a.id)!).startsWith('Waiting to land: a turn is running'), landingWords(box.swarm.registry.get(a.id)!));
    const at = Date.now();
    box.swarm.clock = () => at + (LANDING_BUSY_WAKE_S + 5) * 1000;
    await box.swarm.poll();
    assertEquals(woke.length, 1, JSON.stringify(woke));
    assert(woke[0].text.includes('has not landed yet: a turn is running') && woke[0].text.includes('studio/sub-test1'), woke[0].text);
    assert(notes(main).some((n) => n.includes('is waiting to land: a turn is running')), notes(main).join('\n'));
    await box.swarm.poll();
    assertEquals(woke.length, 1, 'once, not at every poll');
    // a long wait is reminded again
    box.swarm.clock = () => at + (LANDING_REMIND_S + LANDING_BUSY_WAKE_S) * 1000;
    await box.swarm.poll();
    assertEquals(woke.length, 2, JSON.stringify(woke));
    // the wake is a turn of the parent's own (it steers the held turn to its end); once that turn is over the landing goes
    await release().catch(() => {});
    await settle(main);
    for (let i = 0; i < 20 && !log(box.project).includes('AIB: subagent sub 1'); i++) {
      await box.swarm.poll();
      await pause(200);
    }
    assert(log(box.project).includes('AIB: subagent sub 1'), 'landed once idle: ' + JSON.stringify(box.swarm.registry.get(a.id)?.landing));
  },
});

Deno.test({
  ...T,
  name: 'a folder that is not on a branch: the subagent is not landed and the parent is woken with the reason',  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const woke = wakes(box);
    box.subagent(main.id, 'a.txt', 'a\n');
    runGit(box.project, 'checkout', '-q', '--detach');
    await box.swarm.poll();
    await until(() => woke.length > 0, 'woken', 15);
    assert(woke[0].op === 'steer' && woke[0].text.includes("isn't on a branch"), woke[0].text);
    assert(notes(main).some((n) => n.includes("the folder isn't on a branch")), notes(main).join('\n'));
  },
});

Deno.test({
  ...T,
  name: '2026-11-23: a builder the main agent already landed by hand (same patch, file changed since) says so, not a conflict',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const woke = wakes(box);
    const a = box.subagent(main.id, 'hand.txt', 'builder text\n');
    write(box.project, 'hand.txt', 'builder text\n'); // the lead's hand landing: the same change, as one commit
    runGit(box.project, 'add', 'hand.txt');
    runGit(box.project, 'commit', '-q', '-m', 'lead lands it by hand');
    write(box.project, 'hand.txt', 'builder text\nlater edit\n'); // and the file moved on
    runGit(box.project, 'commit', '-q', '-am', 'later edit');
    const before = runGit(box.project, 'rev-parse', 'main').trim();
    await box.swarm.poll();
    await until(() => notes(main).some((n) => n.includes('already landed by hand')), 'said plainly: ' + notes(main).join(' | ') + JSON.stringify(woke) + runGit(box.project, 'log', '--oneline', '-n', '4'), 15);
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), before, 'nothing new landed');
    assert(!notes(main).some((n) => n.includes("couldn't land")), notes(main).join('\n'));
    assertEquals(woke.filter((w) => w.text.includes('conflict')).length, 0, JSON.stringify(woke));
    assertEquals(runGit(box.project, 'branch', '--list', 'studio/sub-test1-landable').trim(), '');
    await until(() => !readSubagents(box.state)[a.id], 'its worktree released', 15);
  },
});

Deno.test('ownSubagentPath: only <root>\\<repo hash>\\sub-*, with no link on the way', () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-sub-path-' }));
  try {
    const root = pathOf(dir, 'worktrees');
    const project = pathOf(dir, 'proj');
    const hash = wt.repoHash(project);
    const own = pathOf(root, hash, 'sub-abc-1');
    Deno.mkdirSync(own, { recursive: true });
    assert(ownSubagentPath(root, { path: own, project }));
    assert(!ownSubagentPath(root, { path: pathOf(root, hash), project }), 'the repo hash folder itself');
    assert(!ownSubagentPath(root, { path: pathOf(root, hash, 'chat-1'), project }), 'a chat copy, not a subagent');
    assert(!ownSubagentPath(root, { path: pathOf(root, 'other', 'sub-abc-1'), project }), "another project's hash");
    assert(!ownSubagentPath(root, { path: pathOf(dir, 'proj', 'sub-x'), project }), 'outside the root');
    const outside = pathOf(dir, 'elsewhere');
    Deno.mkdirSync(outside);
    Deno.symlinkSync(outside, pathOf(root, hash, 'sub-linked'), { type: 'junction' });
    assert(!ownSubagentPath(root, { path: pathOf(root, hash, 'sub-linked'), project }), 'a junction to elsewhere');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
