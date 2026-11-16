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
import { ownSubagentPath, readSubagents } from '../../outputs/agent-studio/server/subagents/service.ts';
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
  subagent(chat: string, file: string, body: string, state: 'done' | 'stopped' = 'done'): { id: string; path: string } {
    const n = ++this.n;
    const root = this.studio.subagents!.root;
    const hash = wt.repoHash(this.project);
    const slug = `sub-test${n}`;
    const path = pathOf(root, hash, slug);
    Deno.mkdirSync(pathOf(root, hash), { recursive: true });
    const s = runGit(this.project, 'rev-parse', 'HEAD').trim();
    runGit(this.project, 'worktree', 'add', '-q', '-b', `studio/${slug}`, path, s);
    runGit(this.project, 'worktree', 'lock', '--reason', 'AIB subagent', path);
    write(path, file, body); // uncommitted, as a subagent leaves it
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
      ...(state === 'done' ? { doneAt: Date.now() / 1000 } : { stoppedAt: Date.now() / 1000, stoppedWhy: 'the turn was stopped' }),
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
