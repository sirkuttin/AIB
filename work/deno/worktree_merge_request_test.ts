/**
 * Chat-first merging (merge_request.ts, merge.ts requestMerge / mergeFromTool): the agent merges whenever the owner says yes in the
 * chat, without a button press; the Changes tab's Merge button only sends the chat the merge message. The target is the project's
 * main branch even when the chat started from another branch; main moving with a conflict is brought into the worktree first; the
 * user's uncommitted edits in the main checkout survive; only helpers inside the chat's own worktree (and its running terminals) hold
 * a merge. Over the fake studio of the merge tests; only temp folders.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { commit, read, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { chat, type Ctx, main, record, show } from './_merge_fixtures.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import * as m from '../../outputs/agent-studio/server/worktrees/merge.ts';
import * as mr from '../../outputs/agent-studio/server/worktrees/merge_request.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import { LiveSync } from '../../outputs/agent-studio/server/worktrees/sync.ts';

const TEXT = "Merge this chat's work into main with AIB's merge tool (merge_into_project). If main has moved and there are conflicts, " +
  'resolve them in this worktree and call it again. Then say in one line what landed.';

async function toolRefused(ctx: Ctx, code: string): Promise<m.Refused> {
  const error = await assertRejects(() => m.mergeFromTool(ctx.studio, ctx.id), m.Refused) as m.Refused;
  assertEquals(error.code, code, error.message);
  return error;
}

function queued(ctx: Ctx): Record<string, unknown>[] {
  return ctx.studio.calls.filter(([op]) => op === 'queue').map(([, p]) => p);
}

function setState(ctx: Ctx, extra: Record<string, unknown>): void {
  ctx.studio.states.set(ctx.id, { ...ctx.studio.states.get(ctx.id)!, ...extra });
}

Deno.test('the fixed message and its marker', () => {
  assertEquals(mr.mergeRequestText('main'), TEXT);
  assert(mr.isMergeRequest(TEXT) && mr.isMergeRequest('  ' + TEXT + '\n'));
  assert(mr.isMergeRequest(mr.mergeRequestText('feature/x')));
  assert(!mr.isMergeRequest(TEXT + ' And also delete the tests.'), 'only the whole message is the chip');
  assert(!mr.isMergeRequest('yes, merge it'));
});

Deno.test('the agent merges without a button press; every merge posts the Merged line and names the target', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'a\n', 'agent work');
  const result = await m.mergeFromTool(ctx.studio, ctx.id);
  assertEquals([result.state, result.target, result.started], ['merged', 'main', 'main']);
  assertEquals(show(ctx, 'main:work.txt'), 'a\n');
  assertEquals(ctx.studio.notes(), ['Merged into main (1 commit)']);
  assertEquals(queued(ctx), [], 'no button involved');
  commit(ctx.wt, 'more.txt', 'b\n', 'more work'); // no one-shot permission: the next "yes" merges again
  assertEquals((await m.mergeFromTool(ctx.studio, ctx.id)).state, 'merged');
  assertEquals(show(ctx, 'main:more.txt'), 'b\n');
  assertEquals(ctx.studio.notes(), ['Merged into main (1 commit)', 'Merged into main (1 commit)']);
});

Deno.test('the button only queues the merge message; the agent then merges with its tool', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'a\n', 'agent work');
  ctx.studio.answer = [200, { ok: true, queued: true }];
  const asked = await m.requestMerge(ctx.studio, ctx.id);
  assertEquals([asked.state, asked.queued, asked.message], [
    'requested',
    true,
    'Merge requested. The chat merges when it finishes its turn',
  ]);
  const [sent] = queued(ctx);
  assertEquals([sent.id, sent.text], [ctx.id, TEXT]);
  assert((sent.clientMessageId as string).startsWith(mr.REQUEST_ID_PREFIX));
  assertEquals(ctx.studio.prompts(), [], 'never sent as a prompt that a busy chat would refuse');
  write(ctx.wt, 'later.txt', 'edited after the click\n'); // an edit after the click is no reason to refuse any more
  ctx.studio.answer = [200, {}];
  assertEquals((await m.mergeFromTool(ctx.studio, ctx.id)).state, 'merged');
  assertEquals(show(ctx, 'main:later.txt'), 'edited after the click\n');
});

Deno.test('a chat made while the folder is on another branch starts from main and merges into main, not into that branch', async () => {
  using box = new Sandbox();
  runGit(box.project, 'switch', '-q', '-c', 'claude/pensive-ritchie');
  commit(box.project, 'side.txt', 'side branch work\n', 'side branch commit');
  const ctx = await chat(box);
  assertEquals(record(ctx).base, 'main'); // chats start from main (worktree_from_main_test.ts covers the chats made before)
  commit(ctx.wt, 'work.txt', 'chat work\n', 'agent work');
  const sideBefore = runGit(box.project, 'rev-parse', 'claude/pensive-ritchie').trim();
  const state = await m.status(ctx.studio, ctx.id);
  assertEquals([state.base, state.label], ['main', 'Merge into main']);
  const result = await m.mergeFromTool(ctx.studio, ctx.id);
  assertEquals([result.state, result.target, result.started, result.base], ['merged', 'main', 'main', 'main']);
  assertEquals(show(ctx, 'main:work.txt'), 'chat work\n');
  assertEquals(runGit(box.project, 'ls-tree', '--name-only', 'main').split('\n').includes('side.txt'), false, "only the chat's own work");
  assertEquals(runGit(box.project, 'rev-parse', 'claude/pensive-ritchie').trim(), sideBefore, 'the start branch is untouched');
  assertEquals(ctx.studio.notes(), ['Merged into main (1 commit)']);
});

Deno.test('main moved with a conflict: reported, nothing lands; resolved in the worktree, the second call lands', async () => {
  using box = new Sandbox();
  commit(box.project, 'f.txt', 'one\ntwo\nthree\n', 'add f');
  const ctx = await chat(box);
  commit(ctx.wt, 'f.txt', 'one\nchat\nthree\n', 'chat edits f');
  commit(box.project, 'f.txt', 'one\nmain\nthree\n', 'main edits f');
  const mainBefore = main(ctx);
  const first = await m.mergeFromTool(ctx.studio, ctx.id);
  assertEquals([first.state, first.files, first.target], ['conflicts', ['f.txt'], 'main']);
  assert((first.message as string).startsWith('Bringing main into this branch left merge conflicts in: f.txt.'));
  assertEquals(main(ctx), mainBefore, 'nothing landed on main');
  assertEquals(show(ctx, 'main:f.txt'), 'one\nmain\nthree\n');
  assert(read(ctx.wt, 'f.txt').includes('<<<<<<<'), 'the conflict is in the worktree for the agent to resolve');
  assertEquals((await toolRefused(ctx, 'conflicts')).extra.target, 'main', 'calling again before resolving is refused');
  write(ctx.wt, 'f.txt', 'one\nmain and chat\nthree\n');
  runGit(ctx.wt, 'add', 'f.txt');
  runGit(ctx.wt, 'commit', '--no-edit');
  const second = await m.mergeFromTool(ctx.studio, ctx.id);
  assertEquals(second.state, 'merged');
  assertEquals(show(ctx, 'main:f.txt'), 'one\nmain and chat\nthree\n');
});

Deno.test("the user's uncommitted edits in the main checkout survive a merge", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'chat\n', 'agent work');
  write(box.project, 'tracked.txt', 'one\nuser edit, not committed\n');
  write(box.project, 'notes.txt', 'new user file\n');
  assertEquals((await m.mergeFromTool(ctx.studio, ctx.id)).state, 'merged');
  assertEquals(show(ctx, 'main:work.txt'), 'chat\n');
  assertEquals(read(box.project, 'tracked.txt'), 'one\nuser edit, not committed\n');
  assertEquals(read(box.project, 'notes.txt'), 'new user file\n');
  assertEquals(read(box.project, 'work.txt'), 'chat\n', 'the main checkout has the merge');
  assertEquals(show(ctx, 'main:tracked.txt'), 'one\n', "the user's edit was not committed");
  assertEquals(box.stashes(), [], 'the stash was put back and dropped');
});

Deno.test('a git operation in progress in the main checkout refuses with a clear reason, and nothing is lost', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'chat\n', 'agent work');
  write(box.project, 'tracked.txt', 'one\nuser edit\n');
  const lock = pathOf(box.project, '.git', 'index.lock');
  Deno.writeTextFileSync(lock, '');
  const before = main(ctx);
  const error = await toolRefused(ctx, 'locked');
  assertEquals(error.message, 'Git is busy in the folder that has the base branch (index.lock exists)');
  Deno.removeSync(lock);
  assertEquals([main(ctx), read(box.project, 'tracked.txt')], [before, 'one\nuser edit\n']);
});

Deno.test('helpers: one in another worktree or of unknown place never blocks; one in this worktree and a terminal do', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'a\n', 'agent work');
  const elsewhere = pathOf(box.base, 'helper-worktree');
  setState(ctx, { subagents: { s1: { state: 'running', title: 'general-purpose', cwd: pathOf(ctx.wt, 'sub') } } });
  assertEquals(
    (await toolRefused(ctx, 'busy')).message,
    "Your subagent general-purpose is still running in this chat's worktree. Wait for it to finish or stop it, then call " +
      'merge_into_project again',
  );
  setState(ctx, { clientCaps: { terminals: [{ id: 'term-7', command: 'npm run dev', status: 'running', cwd: ctx.wt }] }, subagents: {} });
  assertEquals(
    (await toolRefused(ctx, 'busy')).message,
    'A terminal you started is still running (npm run dev), terminal term-7. Stop it first (kill or release that terminal; ask the ' +
      'user if they want it kept running), then call merge_into_project again',
  );
  setState(ctx, {
    clientCaps: { terminals: [] },
    subagents: {
      s1: { state: 'running', title: 'general-purpose', cwd: elsewhere },
      s2: { state: 'running', title: 'test runner' },
    },
  });
  const result = await m.mergeFromTool(ctx.studio, ctx.id);
  assertEquals([result.state, result.helpers], ['merged', ['test runner']], 'the unknown one is named in the reply');
  assertEquals(show(ctx, 'main:work.txt'), 'a\n');
  const sync = m.stateIdleReason({ state: 'ready', subagents: { a: { state: 'running', cwd: elsewhere } } });
  assertEquals(sync, 'A subagent of this chat is still running', 'live sync still waits for every one');
});

Deno.test("a helper's branch merged into the chat's worktree with plain git lands with the chat's work", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'chat\n', 'agent work');
  const helper = pathOf(box.base, 'helper');
  runGit(box.project, 'worktree', 'add', '-q', '-b', 'helper/one', helper, 'main');
  commit(helper, 'helper.txt', 'from the helper\n', 'helper work');
  runGit(ctx.wt, 'merge', '--no-edit', 'helper/one');
  assertEquals((await m.mergeFromTool(ctx.studio, ctx.id)).state, 'merged');
  assertEquals([show(ctx, 'main:work.txt'), show(ctx, 'main:helper.txt')], ['chat\n', 'from the helper\n']);
});

Deno.test('the tool merges while messages are queued and while its own turn runs', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'a\n', 'agent work');
  setState(ctx, { state: 'prompting', busy: true, queue: { items: [{ id: 'q1', text: 'next thing' }] } });
  assertEquals((await m.mergeFromTool(ctx.studio, ctx.id)).state, 'merged');
  assertEquals(show(ctx, 'main:work.txt'), 'a\n');
});

Deno.test('a live-synced user edit never lands', async () => {
  using box = new Sandbox();
  commit(box.project, 'f.txt', 'a\nb\nc\nd\ne\nf\n', 'add f');
  const ctx = await chat(box);
  write(ctx.wt, 'work.txt', 'a\n');
  write(box.project, 'f.txt', 'A-user\nb\nc\nd\ne\nf\n'); // what live sync does: U moves and the worktree gets the file
  await wt.advanceUserBase(record(ctx), ['f.txt'], ctx.manager.registry);
  write(ctx.wt, 'f.txt', 'A-user\nb\nc\nd\ne\nf\n');
  assertEquals((await m.mergeFromTool(ctx.studio, ctx.id)).state, 'merged');
  assertEquals(show(ctx, 'main:work.txt'), 'a\n');
  assertEquals(show(ctx, 'main:f.txt'), 'a\nb\nc\nd\ne\nf\n', "the user's synced line never lands");
});

Deno.test('a tree-landing conflict records mergeConflicts (live sync pauses) until the rework', async () => {
  using box = new Sandbox();
  commit(box.project, 'f.txt', 'a\nb\nc\nd\ne\nf\n', 'add f');
  const ctx = await chat(box);
  write(box.project, 'f.txt', 'A-user\nb\nc\nd\ne\nf\n');
  await wt.advanceUserBase(record(ctx), ['f.txt'], ctx.manager.registry);
  write(ctx.wt, 'f.txt', 'a-chat\nb\nc\nd\ne\nf\n'); // the same line the user edited
  runGit(ctx.wt, 'commit', '-a', '-m', 'chat edits a');
  const answer = await m.mergeFromTool(ctx.studio, ctx.id);
  assertEquals([answer.state, answer.files], ['conflicts', ['f.txt']]);
  assertEquals(answer.message, m.treeConflictLine(null, ['f.txt']));
  assertEquals(record(ctx).mergeConflicts, ['f.txt']);
  const live = new LiveSync(
    { stateDir: box.state, worktrees: null, settings: { worktreePerChat: () => true }, connections: new Map() },
    0.05,
    0.2,
    false,
  );
  assertEquals(await live.blocked(record(ctx)), 'conflicts to resolve', 'live sync waits while the chat reworks');
  write(ctx.wt, 'f.txt', 'A-user\nb\nc\nd\ne\nf-chat\n'); // the rework, left uncommitted: the next call commits it
  assertEquals((await m.mergeFromTool(ctx.studio, ctx.id)).state, 'merged');
  assertEquals(show(ctx, 'main:f.txt'), 'a\nb\nc\nd\ne\nf-chat\n');
  assertEquals(record(ctx).mergeConflicts, []);
});

Deno.test('a closed, read-only, archived or elsewhere chat is refused by the button: no message', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'a\n', 'agent work');
  const refuse = async (options: m.RequestOptions = {}) => {
    const error = await assertRejects(() => m.requestMerge(ctx.studio, ctx.id, options), m.Refused) as m.Refused;
    assertEquals(error.code, 'unavailable');
    return error.message;
  };
  setState(ctx, { closed: true });
  assertEquals(await refuse(), 'This chat is closed. Continue it to merge its work');
  setState(ctx, { closed: false, readOnly: true });
  assertEquals(await refuse(), "This chat is read only, so it can't merge");
  setState(ctx, { readOnly: false });
  assertEquals(
    await refuse({ blocked: () => 'This chat is archived. Unarchive it to merge its work' }),
    'This chat is archived. Unarchive it to merge its work',
  );
  const gone = await assertRejects(() => m.requestMerge(ctx.studio, 'not-live'), m.Refused) as m.Refused;
  assertEquals(gone.code, 'unknown_chat', 'a chat that is not running (open elsewhere, or not resumed) is never resumed for this');
  assertEquals(queued(ctx), []);
  setState(ctx, { closed: true });
  const state = await m.status(ctx.studio, ctx.id);
  assertEquals([state.enabled, state.message], [false, 'This chat is closed. Continue it to merge its work']);
});

Deno.test('a busy chat may be asked; nothing to merge or a refused message is reported', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  const none = await assertRejects(() => m.requestMerge(ctx.studio, ctx.id), m.Refused) as m.Refused;
  assertEquals([none.code, none.message], ['nochanges', 'Nothing to merge yet']);
  commit(ctx.wt, 'work.txt', 'a\n', 'agent work');
  setState(ctx, { state: 'prompting', busy: true });
  const state = await m.status(ctx.studio, ctx.id);
  assertEquals([state.enabled, state.state], [true, 'ready'], 'the message is queued, so a busy chat is no reason to wait');
  ctx.studio.answer = [409, { error: 'This connection is not ready' }];
  const failed = await assertRejects(() => m.requestMerge(ctx.studio, ctx.id), m.Refused) as m.Refused;
  assertEquals([failed.code, failed.message], ['prompt_failed', 'Could not ask the chat to merge: This connection is not ready']);
});

Deno.test('T25: on a working chat that can steer, the button still queues its message for the turn end (never the steer route)', async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, 'work.txt', 'a\n', 'agent work');
  setState(ctx, { state: 'prompting', busy: true, steerable: true, steerAgent: 'claude' });
  ctx.studio.answer = [200, { ok: true, queued: true }];
  const asked = await m.requestMerge(ctx.studio, ctx.id);
  assertEquals([asked.queued, asked.message], [true, 'Merge requested. The chat merges when it finishes its turn']);
  assertEquals(queued(ctx).map((p) => p.text), [TEXT]);
  assertEquals(ctx.studio.calls.filter(([op]) => op === 'steer' || op === 'prompt'), [], "AIB's own sends wait for the turn end");
});
