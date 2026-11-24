/**
 * Swarm, the seven bugs the owner approved fixing on 2026-11-23 (aib-docs/swarm-as-built/01-how-it-works.md, "Found in the code"), one
 * test each, with fake agents and real git in temp folders:
 *   1 `waiting` is set (approval, question, a turn that ends on a question) and helper_status, the report and the registry agree;
 *   2 a long report keeps its head and its end (the closing summary);
 *   3 a helper whose chat is closed is merged from its recorded worktree and branch;
 *   4 Merge again that conflicts posts a line, wakes the main agent and tells the page to re-enable the button;
 *   5 done-but-unmerged helpers count for the cap and the owns clash until merged or discarded;
 *   6 the tip an Undo goes back to is read under the repository lock (a merge landing in between is not undone with it);
 *   7 merged helpers' worktrees and branches are removed (never unmerged work, never an unresolved -landable branch), a sweep at start.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, pause, PYTHON, until } from './_connection.ts';
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py'); // every chat its own session id
import { commit, makeRepo, read, runGit, tryGit, write } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { escapeReply, REPORT_CLIP, wrapReport } from '../../app/server/swarm/brief.ts';
import { Swarm } from '../../app/server/swarm/service.ts';
import { setSwarmEnabled } from '../../app/server/swarm/settings.ts';
import { HOOKS } from '../../app/server/worktrees/merge.ts';
import { pathOf } from '../../app/server/state/paths.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };

const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass every time.',
  owns: ['test/login/**'],
  done_when: 'the login tests pass',
  reply_with: 'cause in one line',
  test_cmd: 'none: not needed in this test',
};

const exists = (path: string) => {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const SEED_BRIEF = { goal: '', owns: [] as string[], avoid: [], done_when: '', reply_with: '', test_cmd: '', read_only: false, context_files: [] };

// ---- bug 2: long reports keep their end -------------------------------------------------------------------------------------------------

Deno.test('bug 2: a long report keeps its first part and its closing summary, with a marker for what was cut', () => {
  const reply = 'HEAD-START ' + 'a'.repeat(1400) + 'M'.repeat(9000) + 'z'.repeat(2400) + ' SUMMARY: all tests pass, nothing outside my files.';
  const clipped = escapeReply(reply);
  assert(clipped.startsWith('HEAD-START '), 'the start is kept');
  assert(clipped.endsWith('SUMMARY: all tests pass, nothing outside my files.'), 'the closing summary survives');
  assert(/… \d+ characters cut from the middle …/.test(clipped), clipped.slice(1500, 1600));
  const cut = Number(/… (\d+) characters cut/.exec(clipped)![1]);
  assertEquals(cut, reply.length - REPORT_CLIP, 'the marker counts exactly what was cut');
  assert(clipped.length < REPORT_CLIP + 80);
  assertEquals(escapeReply('short'), 'short', 'a short reply is untouched');
  const report = wrapReport({
    id: 'h_0123abcd', title: 'T', providerName: 'Codex', model: '', state: 'done', minutes: 1, branch: 'b', commits: 1, files: 1,
    insertions: 1, deletions: 0, outside: [], doneWhen: 'x', reply,
  }, 'deadbeef');
  assert(report.includes('SUMMARY: all tests pass') && report.indexOf('SUMMARY') < report.indexOf('[end of report #deadbeef]'));
});

// ---- a fake host for the bugs that need no real agent (1, 5) ------------------------------------------------------------------------------

function fakeSwarm(dir: string, project: string) {
  const state = { chat: null as Json | null };
  const calls: [string, Json][] = [];
  const main = { id: 'main-1', provider: 'claude', sessionId: 'sm', closed: false, cwd: project, projectRoot: project, worktree: {}, attention: { state: 'idle' }, queue: { items: [] } };
  let events: Json[] = [];
  let cursor = 1;
  const host = {
    liveList: () => Promise.resolve({ instanceId: 'x', connections: [main, ...(state.chat ? [state.chat] : [])] }),
    liveState: (id: unknown) =>
      Promise.resolve(id === 'main-1' ? main : id === 'chat-1' && state.chat ? { ...state.chat, events, cursor } : null),
    liveCall: (name: string, body: unknown) => {
      calls.push([name, body as Json]);
      return Promise.resolve([200, name === 'steer' ? { steered: true } : { ok: true }] as [number, unknown]);
    },
  };
  const swarm = new Swarm({ stateDir: dir, host: host as never, settings: {} });
  setSwarmEnabled(dir, true);
  return {
    swarm,
    calls,
    chat: (c: Json | null) => (state.chat = c ? { id: 'chat-1', provider: 'codex', sessionId: 'sc', closed: false, ...c } : null),
    reply: (text: string) => {
      events = [{ data: { update: { sessionUpdate: 'agent_message_chunk', content: { text } } } }];
      cursor += 1;
    },
  };
}

const seed = (swarm: Swarm, id: string, fields: Json) =>
  swarm.registry.update(id, () =>
    <never> {
      id,
      title: `seed ${id}`,
      project: '',
      parent: { live: 'main-1', lasting: 'claude:sm' },
      chat: { live: '', lasting: '', provider: 'codex', model: '', mode: 'auto' },
      brief: SEED_BRIEF,
      worktree: { path: '', branch: '', base: '', start: '' },
      state: 'working',
      reason: '',
      createdAt: 1,
      turnEndedAt: '',
      cursor: 0,
      reports: [],
      merge: null,
      notes: [],
      ...fields,
    });

Deno.test({
  ...T,
  name: 'bug 1: waiting is set for an approval or question and for a turn that ends on a question; status, report and registry agree',
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-swarm-bug1-' });
    try {
      const f = fakeSwarm(dir, dir);
      await seed(f.swarm, 'h_wait0001', { chat: { live: 'chat-1', lasting: 'codex:sc', provider: 'codex', model: '', mode: 'auto' } });
      const stateOf = () => f.swarm.registry.get('h_wait0001')!.state;
      const status = async () => ((await f.swarm.tool('main-1', 'helper_status', { helper: 'h_wait0001' }))[1] as { helpers: Json[] }).helpers[0];
      f.swarm.clock = (() => { let t = 1_000_000; return () => (t += 120_000); })(); // helper_status is throttled by the clock

      // an approval is open: waiting, with the reason; the same state is in helper_status
      f.chat({ attention: { state: 'needs_you' }, elicitations: [], queue: { items: [] } });
      await f.swarm.poll();
      assertEquals(stateOf(), 'waiting');
      assertEquals([(await status()).state, (await status()).reason], ['waiting', 'waiting for your approval']);
      // answered: the chat works again
      f.chat({ attention: { state: 'working' }, queue: { items: [] } });
      await f.swarm.poll();
      assertEquals(stateOf(), 'working');
      // the turn ends on a question (the chat's own `asks` fact, which the notification reads): waiting, and the report says so
      f.reply('I need to know: which database should the tests use?');
      f.chat({ attention: { state: 'idle', turnEndedAt: '2026-11-23T10:00:00Z', asksAt: '2026-11-23T10:00:00.500Z' }, queue: { items: [] } });
      await f.swarm.poll();
      assertEquals(stateOf(), 'waiting', 'ended on a question: waiting, not done');
      assertEquals((await status()).reason, 'ended on a question');
      const asked = f.swarm.registry.get('h_wait0001')!.reports[0].text;
      assert(asked.includes('state: waiting'), asked);
      assert(asked.includes('The helper is waiting for an answer'), 'the main agent is told not to merge yet');
      assert(!asked.includes('Merge it with merge_helper'));
      // the person answers: working again; this time the turn ends with no question: done
      f.chat({ attention: { state: 'working', turnEndedAt: '2026-11-23T10:00:00Z' }, queue: { items: [] } });
      await f.swarm.poll();
      assertEquals(stateOf(), 'working');
      f.reply('Done. SUMMARY: the tests use sqlite.');
      f.chat({ attention: { state: 'idle', turnEndedAt: '2026-11-23T10:05:00Z' }, queue: { items: [] } });
      await f.swarm.poll();
      assertEquals(stateOf(), 'done');
      assert(f.swarm.registry.get('h_wait0001')!.reports[1].text.includes('state: done'));
      assertEquals((await status()).state, 'done');
      const lines = f.swarm.registry.get('h_wait0001')!.notes.filter((n) => n.kind === 'swarm-report').map((n) => n.text);
      assert(lines[0].endsWith('ended on a question, waiting for an answer'), lines[0]);
      assert(!lines[1].includes('question'), lines[1]);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  ...T,
  name: 'bug 5: done-but-unmerged helpers count for the cap and the owns clash until merged or discarded; read-only ones hold nothing',
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-swarm-bug5-' });
    try {
      const f = fakeSwarm(dir, dir);
      const mine = (owns: string[], state: string, extra: Json = {}) => ({ project: dir, state, brief: { ...SEED_BRIEF, owns }, ...extra });
      await seed(f.swarm, 'h_cap00001', mine(['a/'], 'done'));
      await seed(f.swarm, 'h_cap00002', mine(['b/'], 'done'));
      const start = async (owns: string[]) => (await f.swarm.tool('main-1', 'start_helper', { ...BRIEF, owns }))[1] as Json;
      const clash = await start(['a/x.txt']);
      assertEquals(clash.code, 'owns_clash', 'a done helper still owns its files');
      assert(String(clash.error).includes('finished, not merged yet'), String(clash.error));
      await seed(f.swarm, 'h_cap00003', mine(['c/'], 'working'));
      const capped = await start(['d/']);
      assertEquals(capped.code, 'cap', '2 done + 1 working = 3 places taken');
      assert(String(capped.error).includes('2 finished but not merged yet'), String(capped.error));
      const caps = ((await f.swarm.tool('main-1', 'helper_providers', {}))[1] as { caps: Json }).caps;
      assertEquals(caps.running, 3);
      // merged or discarded: the place and the files are free (a refusal that is not cap or owns_clash means the check passed)
      await f.swarm.registry.patch('h_cap00001', { state: 'merged' });
      await f.swarm.registry.patch('h_cap00002', { state: 'discarded' });
      assertEquals(((await f.swarm.tool('main-1', 'helper_providers', {}))[1] as { caps: Json }).caps.running, 1);
      const free = await start(['a/x.txt']);
      assert(free.code !== 'owns_clash' && free.code !== 'cap', JSON.stringify(free));
      // a done helper that was read-only holds nothing
      for (const id of Object.keys({ h_cap00001: 1, h_cap00002: 1 })) await f.swarm.registry.patch(id, { state: 'done', brief: { ...SEED_BRIEF, owns: ['a/'], read_only: true } });
      assertEquals(((await f.swarm.tool('main-1', 'helper_providers', {}))[1] as { caps: Json }).caps.running, 1);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

// ---- the real AIB, fake agents, real git (3, 4, 6, 7) ---------------------------------------------------------------------------------

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-swarm-bugs-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly aib: Aib;
  readonly swarm: Swarm;
  readonly calls: [string, Json][] = [];

  constructor() {
    setSwarmEnabled(this.state, true);
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0 }, { keeper: null });
    aib.ownerProbe = () => null;
    aib.agentLaunch = () => Promise.resolve([['unused'], {}]);
    aib.connectionFactory = (_command, cwd, provider, options) => new Connection([PYTHON, UNIQUE, '--models'], cwd, provider, options ?? {});
    const live = aib.liveCall.bind(aib);
    aib.liveCall = (name: string, body: unknown) => {
      this.calls.push([name, body as Json]);
      return live(name, body);
    };
    this.aib = aib;
    this.swarm = new Swarm({ stateDir: this.state, host: aib, settings: aib.settings });
    this.swarm.openMs = 30_000;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    delete HOOKS.before_lock;
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

  /** An Own-copy main chat with one helper that has finished a change (committed on its branch) and whose report is in. */
  async helperWithWork(file = 'test/login/a.test.txt', text = 'fixed\n', brief: Json = BRIEF) {
    const main = this.main ??= await this.aib.connect('claude', this.project, null, { ownCopy: true });
    const started = await this.swarm.tool(main.id, 'start_helper', brief);
    assertEquals(started[0], 200, JSON.stringify(started[1]));
    const id = String((started[1] as Json).helper);
    await until(() => this.swarm.registry.get(id)?.state === 'working', 'the helper working', 30);
    const h = this.swarm.registry.get(id)!;
    const helper = this.aib.connections.get(h.chat.live)!;
    await answerApprovals(helper);
    await until(() => !helper.busy, 'the helper turn ended', 15);
    commit(h.worktree.path, file, text, `work of ${id}`);
    await this.swarm.poll();
    await until(() => this.swarm.registry.get(id)?.reports.length === 1 && this.swarm.registry.get(id)!.reports[0].delivered, 'report delivered', 15);
    await answerApprovals(main);
    await until(() => !main.busy, 'the main turn ended', 15);
    return { main, id, h: this.swarm.registry.get(id)!, helper };
  }
  main: Connection | null = null;
}

async function answerApprovals(c: Connection): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (c.busy && Date.now() < deadline) {
    for (const key of [...c.permissions.keys()]) c.permission(key, 'yes');
    await pause(50);
  }
}
const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => e.data as Json);
const branchTip = (box: Box, branch: string) => tryGit(box.project, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)[1].trim();

Deno.test({
  ...T,
  name: 'bug 3: a helper whose chat is closed is merged from its recorded worktree and branch (and its copy is cleaned up after)',
  async fn() {
    await using box = new Box();
    const { main, id, h, helper } = await box.helperWithWork();
    // work that was never committed is kept too: the helper's last edit
    write(h.worktree.path, 'test/login/b.test.txt', 'second\n');
    await box.aib.liveCall('disconnect', { id: helper.id }); // the owner closed the helper's chat
    assert(helper.closed);
    const before = runGit(box.project, 'rev-parse', 'main').trim();
    const merged = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals(merged[0], 200, JSON.stringify(merged[1]));
    assertEquals((merged[1] as Json).state, 'merged', JSON.stringify(merged[1]));
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'fixed\n');
    assertEquals(read(box.project, 'test/login/b.test.txt'), 'second\n', 'uncommitted work was committed on its branch first and landed');
    const rec = box.swarm.registry.get(id)!;
    assertEquals(rec.state, 'merged');
    assertEquals(rec.merge!.tipBefore, before, 'the range is exactly this merge');
    const lines = notes(main).filter((n) => n.kind === 'swarm-merge');
    assertEquals(lines.length, 1);
    assert(String(lines[0].message).startsWith('Merged “Login tests” (Codex) into main · '), String(lines[0].message));
    assertEquals((lines[0].actions as Json[]).map((a) => a.id), ['swarm-undo']);
    // the copy of a merged helper whose chat is closed goes at once (bug 7)
    assert(!exists(h.worktree.path), 'its worktree was removed');
    assertEquals(branchTip(box, h.worktree.branch), '', 'and its branch');
    assert((box.swarm.registry.get(id)!.cleanedAt ?? 0) > 0);
    // Undo still works from the commits on main, with the copy gone
    const undone = await box.swarm.undo(id);
    assertEquals((undone[1] as Json).state, 'undone', JSON.stringify(undone[1]));
    assert(!exists(pathOf(box.project, 'test/login/a.test.txt')));
    assertEquals(box.swarm.registry.get(id)!.state, 'discarded', 'nothing left to merge by merge_helper');
    const again = await box.swarm.mergeAgain(id);
    assertEquals((again[1] as Json).state, 'merged', JSON.stringify(again[1]));
    assertEquals(read(box.project, 'test/login/a.test.txt'), 'fixed\n');
    // a closed helper whose worktree is gone cannot be merged: a plain refusal, not a crash
    const gone = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals([gone[0], (gone[1] as Json).code], [409, 'merged']);
  },
});

Deno.test({
  ...T,
  name: 'bug 4: Merge again that conflicts posts a line, wakes the main agent and leaves the button usable',
  async fn() {
    await using box = new Box();
    const { main, id } = await box.helperWithWork();
    const merged = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals((merged[1] as Json).state, 'merged', JSON.stringify(merged[1]));
    assertEquals(((await box.swarm.undo(id))[1] as Json).state, 'undone');
    // after the Undo, main gets its own version of the same file: re-applying the helper's change now conflicts
    commit(box.project, 'test/login/a.test.txt', 'main wrote this meanwhile\n', 'main edit');
    const tip = runGit(box.project, 'rev-parse', 'main').trim();
    box.calls.length = 0;
    const out = await box.swarm.mergeAgain(id);
    assertEquals(out[0], 200);
    assertEquals((out[1] as Json).state, 'cannot_merge');
    assertEquals(runGit(box.project, 'rev-parse', 'main').trim(), tip, 'nothing changed');
    const line = notes(main).map((n) => String(n.message)).findLast((m) => m.startsWith('Couldn’t merge') || m.startsWith("Couldn't merge"));
    assert(line, 'a line was posted: ' + JSON.stringify(notes(main).map((n) => n.message)));
    assert(line.startsWith("Couldn't merge “Login tests” (Codex) again: conflict in 1 file (test/login/a.test.txt)"), line);
    const woke = box.calls.find(([name, body]) => ['steer', 'queue', 'prompt-context'].includes(name) && String(body.text ?? body.line).includes('conflicts with main'));
    const text = String(woke?.[1].text ?? woke?.[1].line);
    assert(text.includes('Login tests') && text.includes('test/login/a.test.txt'), 'the main agent was told: ' + JSON.stringify(box.calls.map((c) => c[0])));
    assertEquals(box.swarm.registry.get(id)!.merge!.undo !== null, true, 'still undone: Merge again can be tried later');
    // the page: the button comes back (chat.js re-enables it for this answer)
    const page = Deno.readTextFileSync(new URL('../../app/page/chat.js', import.meta.url));
    assert(/done\?\.state === 'dirty' \|\| done\?\.state === 'cannot_merge'\) for \(const b of box\.querySelectorAll\('button'\)\) b\.disabled = false/.test(page));
  },
});

Deno.test({
  ...T,
  name: 'bug 6: Undo takes back only its own merge: a merge that landed between the read of the tip and the lock stays',
  async fn() {
    await using box = new Box();
    const { main, id } = await box.helperWithWork();
    let interloper = '';
    HOOKS.before_lock = () => { // runs once, after Merge read main's tip and before it takes the repository lock
      delete HOOKS.before_lock;
      commit(box.project, 'other/landed-meanwhile.txt', 'another merge\n', 'another merge landed');
      interloper = runGit(box.project, 'rev-parse', 'main').trim();
    };
    const merged = await box.swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals((merged[1] as Json).state, 'merged', JSON.stringify(merged[1]));
    assert(interloper, 'the other merge landed in between');
    const rec = box.swarm.registry.get(id)!;
    assertEquals(rec.merge!.tipBefore, interloper, 'tipBefore is the tip under the lock, not the one read before it');
    assertEquals(runGit(box.project, 'rev-parse', `${rec.merge!.landed}~${rec.merge!.commits}`).trim(), interloper);
    assertEquals(((await box.swarm.undo(id))[1] as Json).state, 'undone');
    assert(!exists(pathOf(box.project, 'test/login/a.test.txt')), 'its own change is taken back');
    assertEquals(read(box.project, 'other/landed-meanwhile.txt'), 'another merge\n', 'the other merge is still there');
  },
});

Deno.test({
  ...T,
  name: 'bug 7: merged helpers are cleaned up (closed chat), unmerged work and unresolved -landable branches stay, the start sweeps leftovers',
  async fn() {
    await using box = new Box();
    const a = await box.helperWithWork('test/login/a.test.txt', 'one\n');
    const b = await box.helperWithWork('test/login/b2.test.txt', 'two\n', { ...BRIEF, title: 'Second', owns: ['test/other/**'] });
    const c = await box.helperWithWork('test/login/c3.test.txt', 'three\n', { ...BRIEF, title: 'Third', owns: ['test/third/**'] });

    // A is merged while its chat is open: the chat is still there, so nothing is removed yet
    assertEquals(((await box.swarm.tool(a.main.id, 'merge_helper', { helper: a.id }))[1] as Json).state, 'merged');
    assert(exists(a.h.worktree.path), 'a merged helper whose chat is open keeps its copy');
    // B stays unmerged; its chat is closed: its copy and branch stay (unmerged work)
    await box.aib.liveCall('disconnect', { id: b.helper.id });
    // C is merged, then its chat closes, then the helper does more work on its branch: that is unmerged work too
    assertEquals(((await box.swarm.tool(c.main.id, 'merge_helper', { helper: c.id }))[1] as Json).state, 'merged');
    await c.helper.close(); // closed without AIB's own retire: only AIB's start sweep can find it
    commit(c.h.worktree.path, 'test/login/after-merge.txt', 'new work\n', 'more work after the merge');
    // an unresolved -landable branch (a conflicting landing's clean branch) and one the main agent merged by hand
    const open = box.swarm.registry.get(b.id)!.worktree.branch;
    runGit(box.project, 'branch', `${open}-landable`, open); // holds B's own commit: not in main
    runGit(box.project, 'branch', `${c.h.worktree.branch}-landable`, 'HEAD'); // equals main: in the target already

    // the owner closes A's chat (AIB retires a merged copy when its chat closes), and a fresh process starts: its first look sweeps
    await a.helper.close();
    const fresh = new Swarm({ stateDir: box.state, host: box.aib, settings: box.aib.settings });
    await fresh.poll();
    assert(!exists(a.h.worktree.path), "merged helper A's worktree is removed");
    assertEquals(branchTip(box, a.h.worktree.branch), '', "and A's branch");
    assert(exists(b.h.worktree.path) && branchTip(box, b.h.worktree.branch), 'unmerged B is kept');
    assert(exists(c.h.worktree.path) && branchTip(box, c.h.worktree.branch), 'C has new work since its merge: kept');
    assertEquals(fresh.registry.get(c.id)!.cleanedAt, undefined);
    assert(branchTip(box, `${open}-landable`), 'a -landable branch not merged anywhere is kept');
    assertEquals(branchTip(box, `${c.h.worktree.branch}-landable`), '', 'a -landable branch that is in main already goes');
    assert((fresh.registry.get(a.id)!.cleanedAt ?? 0) > 0);

    // a helper that is gone without a merge (its chat was deleted: worktree and branch removed) is discarded and stops counting
    runGit(box.project, 'worktree', 'remove', '--force', b.h.worktree.path);
    runGit(box.project, 'branch', '-D', b.h.worktree.branch);
    runGit(box.project, 'branch', '-D', `${open}-landable`);
    // the next sweep is due after SWEEP_MS
    fresh.clock = () => Date.now() + 120_000;
    await fresh.poll();
    assertEquals(fresh.registry.get(b.id)!.state, 'discarded');
    const refused = await fresh.tool(b.main.id, 'merge_helper', { helper: b.id });
    assertEquals([refused[0], (refused[1] as Json).code], [409, 'gone']);
  },
});
