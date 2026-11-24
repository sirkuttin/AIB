/**
 * Owner rule 2026-11-24: "the main agent should take care of 100% of this". Unlanded subagent work goes to a main chat, never to the
 * owner. Fake agent, headless: a real AIB with the fake agent as the parent chat, subagent records and worktrees made the way
 * subagents/service.ts makes them (as in subagent_landing_test.ts), and the web process's swarm (swarm/service.ts #handOff, the
 * unlanded_work tool).
 *   - a stopped subagent with unlanded work wakes its starting chat exactly once, with the one plain line and the tool
 *   - after a restart (a new Swarm over the same state) nobody is woken again
 *   - unlanded_work: land (the normal landing), diff (a patch file that applies by hand; AIB then removes the copy), discard (a reason
 *     is required; the branch studio/discarded/<name> keeps the work, the copy and record go)
 *   - the starting chat is gone: the work goes to the project's main chat, which can land it too
 *   - work that is in main already never wakes anyone
 *   - the Changes tab: "Being handled by <chat>" per piece, no owner buttons (project_changes.ts handler; the page is
 *     work/test_changes_ui.js and project_changes_e2e_test.ts)
 *   - helpers' tools: the same tool for a WSL chat (artifacts/mcp.ts); the real WSL flow is wsl_unlanded_e2e_test.ts
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, FAKE_UNIQUE, pause, NODE, until } from './_connection.ts';
import { makeRepo, runGit, write } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { Swarm } from '../../app/server/swarm/service.ts';
import { readHandoffs } from '../../app/server/swarm/handoff.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { readSubagents, type SubagentRecord } from '../../app/server/subagents/service.ts';
import { projectChanges } from '../../app/server/worktrees/project_changes.ts';
import { UNLANDED_TOOLS } from '../../app/server/artifacts/mcp.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE_UNIQUE;

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-unlanded-' }));
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
      new Connection([NODE, UNIQUE, '--models'], cwd, provider, { ...(options ?? {}), env: { ...(options?.env ?? {}), PYTHONUTF8: '1' } });
    this.aib = aib;
    this.swarm = this.newSwarm();
  }

  newSwarm(): Swarm {
    return new Swarm({ stateDir: this.state, host: this.aib, settings: this.aib.settings });
  }

  /** A subagent's worktree and record as subagents/service.ts makes them (S = the folder's HEAD), with `file` changed in it. */
  subagent(
    chat: string,
    file: string,
    body: string,
    state: 'done' | 'stopped' = 'stopped',
    more: Partial<SubagentRecord> & { commit?: boolean } = {},
  ): { id: string; path: string; branch: string } {
    const n = ++this.n;
    const root = this.aib.subagents!.root;
    const hash = wt.repoHash(this.project);
    const slug = `sub-test${n}`;
    const path = pathOf(root, hash, slug);
    Deno.mkdirSync(pathOf(root, hash), { recursive: true });
    const s = runGit(this.project, 'rev-parse', 'HEAD').trim();
    runGit(this.project, 'worktree', 'add', '-q', '-b', `studio/${slug}`, path, s);
    runGit(this.project, 'worktree', 'lock', '--reason', 'AIB subagent', path);
    const { commit, ...fields } = more;
    write(path, file, body);
    if (commit) {
      runGit(path, 'add', '-A');
      runGit(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub work');
    }
    const id = `sa_test${n}`;
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
      ...fields,
    };
    Deno.writeTextFileSync(pathOf(this.state, 'subagent-worktrees.json'), JSON.stringify({ version: 1, subagents: all }));
    return { id, path, branch: `studio/${slug}` };
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

/** Every line that reaches a chat: steer / queue wakes and next-prompt lines. */
function told(box: Box): { op: string; id: string; text: string }[] {
  const out: { op: string; id: string; text: string }[] = [];
  const own = box.aib.liveCall.bind(box.aib);
  box.aib.liveCall = (name, body) => {
    if (name === 'steer' || name === 'queue') out.push({ op: name, id: String((body as Json).id), text: String((body as Json).text) });
    if (name === 'prompt-context') out.push({ op: name, id: String((body as Json).id), text: String((body as Json).line) });
    return own(name, body);
  };
  return out;
}
const handoffLines = (lines: { id: string; text: string }[]) => lines.filter((l) => l.text.includes('unlanded_work'));

/** Polls until the swarm has looked twice (the first look of a piece of work waits one poll). */
async function polls(box: Box, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await box.swarm.poll();
}

Deno.test({
  ...T,
  name: 'a stopped subagent with unlanded work wakes its starting chat once, with the plain line; a restart does not wake again',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const lines = told(box);
    const { id } = box.subagent(main.id, 'half.txt', 'half\nmore\n', 'stopped', { description: 'Fix login' });
    await polls(box, 4);
    const sent = handoffLines(lines);
    assertEquals(sent.length, 1, JSON.stringify(sent));
    assertEquals(sent[0].id, main.id);
    assert(
      sent[0].text.startsWith('Subagent “Fix login” stopped before its work landed (1 file). Land it, merge it by hand, or discard it.'),
      sent[0].text,
    );
    assert(sent[0].text.includes(`work "${id}"`) && sent[0].text.includes('land, diff or discard'), sent[0].text);
    assertEquals(Object.keys(readHandoffs(box.state)), [id], 'the ledger remembers it');
    assert(!log(box.project).includes('AIB: subagent Fix login'), 'a stopped subagent never lands by itself');
    // AIB restarts: a new Swarm over the same state, the same open chat: nobody is told again
    await box.swarm.stopWatching();
    box.swarm = box.newSwarm();
    await polls(box, 4);
    assertEquals(handoffLines(lines).length, 1, 'no second wake after a restart');
  },
});

Deno.test({
  ...T,
  name: 'unlanded_work: land lands it, diff gives a patch that applies by hand and the copy then goes, discard needs a reason and keeps the branch',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const tool = (id: string, args: Json) => box.swarm.tool(main.id, 'unlanded_work', { work: id, ...args });

    // land: the normal landing path (swarm is on or off: the tool is always there)
    const a = box.subagent(main.id, 'landed.txt', 'one\n', 'stopped', { description: 'Land me' });
    await polls(box, 2);
    await settle(main); // the wake started a turn: a landing waits for the chat to be idle
    const [code, out] = await tool(a.id, { action: 'land' });
    assertEquals(code, 200, JSON.stringify(out));
    assertEquals((out as Json).state, 'queued');
    await polls(box, 2);
    await settle(main);
    await polls(box, 2);
    await until(() => log(box.project).includes('AIB: subagent Land me'), 'landed through the tool', 15);
    await until(() => !readSubagents(box.state)[a.id], 'its copy released after landing', 15);

    // diff: the work as a patch file; applying it by hand in the folder, then the copy goes by itself
    const b = box.subagent(main.id, 'by-hand.txt', 'two\n', 'stopped', { description: 'Merge me by hand' });
    await polls(box, 2);
    await settle(main);
    const [dcode, diff] = await tool(b.id, { action: 'diff' });
    assertEquals(dcode, 200, JSON.stringify(diff));
    const d = diff as Json;
    assertEquals(d.files, ['by-hand.txt']);
    assert(String(d.stat).includes('by-hand.txt'), String(d.stat));
    assert(String(d.patch).includes('+++ b/by-hand.txt') && String(d.patch).includes('+two'), String(d.patch));
    assert(exists(String(d.patchFile)), 'the patch file exists');
    runGit(box.project, 'apply', '--3way', String(d.patchFile));
    runGit(box.project, 'add', 'by-hand.txt');
    runGit(box.project, 'commit', '-q', '-m', 'merged by hand');
    box.swarm.clock = () => Date.now() + 120_000; // past the once-a-minute look at each copy
    await polls(box, 2);
    await until(() => !readSubagents(box.state)[b.id], 'its copy released after the hand merge', 15);
    assert(!exists(b.path));

    // discard: a reason is required; the branch keeps the work; the copy and record go
    const c = box.subagent(main.id, 'give-up.txt', 'three\n', 'stopped', { description: 'Give up' });
    await polls(box, 2);
    const [ncode, noReason] = await tool(c.id, { action: 'discard' });
    assert(ncode >= 400, JSON.stringify(noReason));
    assert(exists(c.path), 'nothing was removed without a reason');
    const [xcode, gone] = await tool(c.id, { action: 'discard', reason: 'superseded by the new design' });
    assertEquals(xcode, 200, JSON.stringify(gone));
    const kept = String((gone as Json).branch);
    assertEquals(kept, 'studio/discarded/sub-test3');
    assertEquals(runGit(box.project, 'show', `${kept}:give-up.txt`), 'three\n', 'the branch holds the work');
    await until(() => !readSubagents(box.state)[c.id], 'its record released', 15);
    assert(!exists(c.path), 'its copy is gone');
    assertEquals(runGit(box.project, 'branch', '--list', 'studio/sub-test3').trim(), '', 'the working branch went with the copy');
    assert(!log(box.project).includes('Give up'), 'discarded work did not land');
    assertEquals(readHandoffs(box.state)[c.id]?.discarded?.reason, 'superseded by the new design');
    // unknown ids and a list
    assertEquals((await tool('sa_nope', { action: 'land' }))[0], 404);
    const [lcode, list] = await box.swarm.tool(main.id, 'unlanded_work', { action: 'list' });
    assertEquals(lcode, 200);
    assertEquals(((list as Json).items as unknown[]).length, 0, JSON.stringify(list));
  },
});

Deno.test({
  ...T,
  name: 'a starting chat that is gone hands the work to the project\'s main chat, which can land it',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const lines = told(box);
    // started by a chat that no longer exists
    const { id } = box.subagent('ghost-chat', 'orphan.txt', 'left\n', 'stopped', { description: 'Orphan work', lasting: 'claude:ghost' });
    box.swarm.handoffOrphanS = 0; // (the chat gets a grace period to come back; tests skip it)
    await polls(box, 4);
    const sent = handoffLines(lines);
    assertEquals(sent.length, 1, JSON.stringify(sent));
    assertEquals(sent[0].id, main.id, 'handed to the open main chat');
    assert(sent[0].text.startsWith('Subagent “Orphan work” stopped before its work landed (1 file).'), sent[0].text);
    assert(sent[0].text.includes('The chat that started it is gone, so it comes to you.'), sent[0].text);
    assertEquals(readHandoffs(box.state)[id]?.to.live, main.id);
    // the main chat lands it: the parent becomes this chat, the landing runs when it is idle
    await settle(main);
    const [code, out] = await box.swarm.tool(main.id, 'unlanded_work', { work: id, action: 'land' });
    assertEquals(code, 200, JSON.stringify(out));
    await polls(box, 3);
    await settle(main);
    await polls(box, 2);
    await until(() => log(box.project).includes('AIB: subagent Orphan work'), 'landed by the main chat', 15);
    // nobody is told again
    assertEquals(handoffLines(lines).length, 1);
  },
});

Deno.test({
  ...T,
  name: 'work that is in main already never wakes anyone',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const lines = told(box);
    // the subagent committed a.txt; the main agent made the same file by hand
    const { id } = box.subagent(main.id, 'same.txt', 'identical\n', 'stopped', { description: 'Already there', commit: true });
    write(box.project, 'same.txt', 'identical\n');
    runGit(box.project, 'add', 'same.txt');
    runGit(box.project, 'commit', '-q', '-m', 'same file by hand');
    await polls(box, 4);
    assertEquals(handoffLines(lines).filter((l) => l.text.includes('Already there')).length, 0, JSON.stringify(lines));
    assertEquals(readHandoffs(box.state)[id], undefined);
  },
});

Deno.test({
  ...T,
  name: 'the Changes tab: left-over work names the chat handling it, and has no owner buttons',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const { id } = box.subagent(main.id, 'pending.txt', 'x\n', 'stopped', { description: 'Pending work' });
    await polls(box, 3);
    const read = async () =>
      await projectChanges({
        folder: box.project,
        stateDir: box.state,
        subs: readSubagents(box.state),
        helpers: box.swarm.registry.all(),
        handoffs: readHandoffs(box.state),
        fold: new Set(),
        unfold: new Set(),
      });
    const reply = await read() as { left: Json[] };
    assertEquals(reply.left.length, 1);
    assertEquals(reply.left[0].id, id);
    const handler = reply.left[0].handler as Json;
    assertEquals(handler.live, main.id);
    // no entry, no handler
    const bare = await projectChanges({ folder: box.project, stateDir: box.state, subs: readSubagents(box.state), helpers: box.swarm.registry.all(), fold: new Set(), unfold: new Set() }) as { left: Json[] };
    assertEquals(bare.left[0].handler, null);
    // landed or discarded: nothing at all
    await box.swarm.tool(main.id, 'unlanded_work', { work: id, action: 'discard', reason: 'test' });
    await until(() => !readSubagents(box.state)[id], 'released', 15);
    assertEquals(((await read()) as { left: Json[] }).left.length, 0);
  },
});

Deno.test({
  ...T,
  name: 'the tool is offered to main chats and to WSL chats, with one definition for every agent',
  fn() {
    assertEquals(UNLANDED_TOOLS.map((t) => t.name), ['unlanded_work']);
    const schema = UNLANDED_TOOLS[0].inputSchema as { properties: Json; required: string[] };
    assertEquals(Object.keys(schema.properties).sort(), ['action', 'reason', 'work']);
    assertEquals(schema.required, ['action']);
  },
});

Deno.test({
  ...T,
  name: 'a landing that failed (conflict) wakes once through its own line; the hand-over does not say it again',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, {});
    await settle(main);
    const lines = told(box);
    const { id } = box.subagent(main.id, 'tracked.txt', 'the subagent version\n', 'done', { description: 'Clash' });
    write(box.project, 'tracked.txt', 'the main version\n');
    runGit(box.project, 'commit', '-q', '-am', 'main moved on');
    await polls(box, 2);
    await until(() => lines.some((l) => l.text.includes('did not land')), 'the conflict wake', 15);
    await settle(main);
    await polls(box, 4);
    assertEquals(lines.filter((l) => l.text.includes('Clash') && l.op !== 'prompt-context').length, 1, JSON.stringify(lines));
    assertEquals(readHandoffs(box.state)[id]?.why, 'conflict', 'the failed landing wrote the ledger entry');
  },
});
