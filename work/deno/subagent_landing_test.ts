/**
 * Subagent worktrees P2 (landing), without a real agent: a real Studio with the fake agent as the parent chat, subagent records and
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
import { makeRepo, runGit, write } from './_worktree_fixtures.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { Swarm } from '../../outputs/agent-studio/server/swarm/service.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import { ownSubagentPath, readSubagents, type SubagentRecord } from '../../outputs/agent-studio/server/subagents/service.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py');

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-sub-landing-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly studio: Studio;
  swarm: Swarm;
  n = 0;

  constructor() {
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    runGit(this.project, 'config', 'core.autocrlf', 'false');
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0 }, { keeper: null });
    studio.ownerProbe = () => null;
    studio.agentLaunch = () => Promise.resolve([['unused'], {}]);
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection([PYTHON, UNIQUE, '--models'], cwd, provider, { ...(options ?? {}), env: { ...(options?.env ?? {}), PYTHONUTF8: '1' } });
    this.studio = studio;
    this.swarm = this.newSwarm();
  }

  newSwarm(): Swarm {
    return new Swarm({ stateDir: this.state, host: this.studio, settings: this.studio.settings });
  }

  /** A subagent's worktree and record as subagents/service.ts makes them (S = the folder's HEAD here), with `file` changed in it. */
  subagent(
    chat: string,
    file: string,
    body: string,
    state: 'done' | 'stopped' | 'running' = 'done',
    more: Partial<SubagentRecord> & { files?: Record<string, string>; commit?: boolean } = {},
  ): { id: string; path: string } {
    const n = ++this.n;
    const root = this.studio.subagents!.root;
    const hash = wt.repoHash(this.project);
    const slug = `sub-test${n}`;
    const path = pathOf(root, hash, slug);
    Deno.mkdirSync(pathOf(root, hash), { recursive: true });
    const s = runGit(this.project, 'rev-parse', 'HEAD').trim();
    runGit(this.project, 'worktree', 'add', '-q', '-b', `studio/${slug}`, path, s);
    runGit(this.project, 'worktree', 'lock', '--reason', 'AIB subagent', path);
    const { files, commit, ...fields } = more;
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
    const main = await box.studio.connect('claude', box.project, null, {});
    await settle(main);
    write(box.project, 'dirty.txt', 'main-edit\n'); // the main agent's uncommitted edit
    const target = pathOf(box.dir, 'linked-pkg');
    write(target, 'index.js', 'keep me\n');
    const { id, path } = box.subagent(main.id, 'sub.txt', 'from-sub\n');
    Deno.symlinkSync(target, pathOf(path, 'node_modules'), { type: 'junction' }); // an `npm link` in the subagent's worktree
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
    const main = await box.studio.connect('claude', box.project, null, {});
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
    const main = await box.studio.connect('claude', box.project, null, {});
    await settle(main);
    const { id } = box.subagent(main.id, 'stopped.txt', 'half\n', 'stopped');
    await box.swarm.poll();
    await box.swarm.poll();
    assert(!log(box.project).includes('AIB: subagent sub 1'), 'a stopped subagent landed');
    assert(notes(main).some((n) => n.startsWith('Subagent “sub 1” was stopped before it finished')), notes(main).join('\n'));
    const [code, out] = await box.swarm.tool(main.id, 'merge_helper', { helper: id }); // swarm off: still accepted for a subagent id
    assertEquals(code, 200, JSON.stringify(out));
    await box.swarm.poll();
    await until(() => log(box.project).includes('AIB: subagent sub 1'), 'landed on merge_helper', 15);
  },
});

/** The parent's next-prompt lines (prompt-context), as the Studio collects them. */
function contextLines(box: Box): string[] {
  const lines: string[] = [];
  const own = box.studio.addPromptContext.bind(box.studio);
  box.studio.addPromptContext = (c, line, replace) => {
    lines.push(line);
    own(c, line, replace);
  };
  return lines;
}

Deno.test({
  ...T,
  name: 'scratch: a subagent that only left a page and a note at its worktree top lands nothing, keeps them and tells the parent; merge_helper lands them',
  async fn() {
    await using box = new Box();
    const main = await box.studio.connect('claude', box.project, null, {});
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
    const main = await box.studio.connect('claude', box.project, null, {});
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
    const main = await box.studio.connect('claude', box.project, null, {});
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
    const main = await box.studio.connect('claude', box.project, null, {});
    await settle(main);
    const release = await holdTurn(box, main, 'names');
    const { id } = box.subagent(main.id, 'spike.js', 'x\n', 'done', { description: 'Inbox v3.1: design + toast research' });
    await box.swarm.poll();
    assertEquals(box.swarm.registry.get(id)?.landing?.stage, 'queued');
    const all = readSubagents(box.state); // the Studio fixed the pairing (subagents/service.ts swapCalls)
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
      const main = await box.studio.connect('claude', box.project, null, {});
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
      await main.prompt('next'); // the chat's next turn end adopts them (host/studio.ts turnEnded -> reconcileEnded)
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
