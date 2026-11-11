/**
 * server/worktrees/merge.ts: the cases of work/test_worktree_merge.py, test_worktree_e2.py, test_worktree_userbase.py and
 * test_worktree_g3.py that exercise worktree_merge.py directly (over a fake studio instead of a whole Studio), parity with Python on
 * identical repos (same result, same commits, same registry record, same live calls), and the cross-process locks.
 *
 * Skipped (they need a whole Studio, a live connection, HTTP routes or the host-side live sync): the agent prompt/instruction tests,
 * the merge tool over HTTP with artifact keys, route scopes and tokens, resume after merge through Studio.connect, changes_response,
 * real turns ending (idle()), and the live-sync flows of test_worktree_g3.py (turn-end merging, merge_pending, stale writes, binary and
 * .env notes). The sync helpers Merge itself calls (settle_conflicts, open_clashes, clash_line, paused_status) are covered here.
 */
import { assert, assertEquals, assertRejects } from "./_assert.ts";
import { commit, pythonProbe, read, runGit, Sandbox, write } from "./_worktree_fixtures.ts";
import { chat, main, merge, record, refused, Refused, show, tree, WAITING } from "./_merge_fixtures.ts";
import * as m from "../../outputs/agent-studio/server/worktrees/merge.ts";
import { pathOf } from "../../outputs/agent-studio/server/state/paths.ts";

// ---- landing (test_worktree_merge.py) --------------------------------------------------------------------------------
Deno.test("a clean merge lands only the chat's commits and keeps the user's edits", async () => {
  using box = new Sandbox();
  write(box.project, "mine.txt", "my own work\n"); // uncommitted in main before the chat: copied into S
  write(box.project, "tracked.txt", "one\nuser edit\n");
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n", "agent commit");
  write(ctx.wt, "late.txt", "not committed yet\n");
  const before = main(ctx);
  const result = await merge(ctx.studio, ctx.id, "My title");
  assertEquals([result.state, result.commits, result.message], [
    "merged",
    2,
    "Merged into main (2 commits)",
  ]);
  const log = runGit(box.project, "log", "--format=%s", `${before}..main`)
    .split("\n").filter(Boolean);
  assertEquals(log.sort(), ["AIB: work from chat My title", "agent commit"]);
  assert(tree(ctx).includes("committed.txt") && tree(ctx).includes("late.txt"));
  assert(!tree(ctx).includes("mine.txt"), "S is never committed");
  assertEquals(show(ctx, "main:tracked.txt"), "one\n");
  assertEquals(box.status().split("\n").filter(Boolean).sort(), [
    " M tracked.txt",
    "?? mine.txt",
  ], "the user's own edits are back");
  assertEquals(read(box.project, "tracked.txt"), "one\nuser edit\n");
  assertEquals(box.stashes(), [], "the stash Studio made is gone");
  assertEquals([result.clash, result.stash, result.base, result.tip], [
    [],
    "",
    "main",
    main(ctx),
  ]);
});

Deno.test("after a merge the chat goes on and a second merge works from the new base", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n", "agent commit");
  const result = await merge(ctx.studio, ctx.id, "T");
  const tip = main(ctx);
  assertEquals(runGit(ctx.wt, "rev-parse", "HEAD").trim(), tip);
  assertEquals(box.status(ctx.wt), "");
  const rec = record(ctx);
  assertEquals([rec.snapshot, rec.diffBase, rec.user], [tip, tip, tip]);
  assertEquals([
    rec.mergeConflicts,
    rec.pendingSync,
    rec.syncConflicts,
    rec.syncMerged,
    rec.turnUser,
  ], [[], [], [], {}, ""]);
  assertEquals(ctx.studio.notes(), ["Merged into main (1 commit)"]);
  assertEquals(result.message, ctx.studio.notes()[0]);
  assertEquals(ctx.studio.calls[0][1].id, ctx.id);
  const state = await m.status(ctx.studio, ctx.id);
  assertEquals([state.enabled, state.state, state.label], [
    false,
    "nochanges",
    "Merge into main",
  ]);
  commit(ctx.wt, "second.txt", "b\n", "more");
  assertEquals(
    (await merge(ctx.studio, ctx.id, "T")).message,
    "Merged into main (1 commit)",
  );
  assert(tree(ctx).includes("second.txt"));
});

Deno.test("base moved without conflicts is updated, then merged", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "chat.txt", "chat\n", "chat work");
  commit(box.project, "other.txt", "user commit\n", "user commit on main");
  assertEquals((await merge(ctx.studio, ctx.id, "T")).state, "merged");
  assert(tree(ctx).includes("other.txt") && tree(ctx).includes("chat.txt"));
  assertEquals(
    runGit(box.project, "log", "--format=%s", "-1", "main").trim(),
    "chat work",
  );
  assertEquals(
    runGit(ctx.wt, "rev-parse", "HEAD"),
    runGit(box.project, "rev-parse", "main"),
  );
});

Deno.test("a chat with nothing new is refused", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  assertEquals((await m.status(ctx.studio, ctx.id)).state, "nochanges");
  assertEquals(await refused(ctx, "empty"), "Nothing to merge into main");
});

// ---- conflicts ---------------------------------------------------------------------------------------------------------
Deno.test("conflicts prompt the chat and merge waits until they are really resolved", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "tracked.txt", "chat line\n", "chat edit");
  commit(box.project, "tracked.txt", "main line\n", "main edit");
  const result = await merge(ctx.studio, ctx.id, "T");
  assertEquals([result.state, result.message, result.files], [
    "conflicts",
    WAITING,
    ["tracked.txt"],
  ]);
  const prompt = ctx.studio.prompts().at(-1)!;
  assert(prompt.includes("tracked.txt") && prompt.includes("conflict"));
  assertEquals(prompt, m.conflictLine({ base: "main" }, ["tracked.txt"]));
  assert(
    (ctx.studio.calls.at(-1)![1].clientMessageId as string).startsWith(
      "merge-",
    ),
  );
  assert(await m.mergeInProgress(ctx.wt), "the merge is kept for the chat");
  assertEquals(record(ctx).mergeConflicts, ["tracked.txt"]);
  const state = await m.status(ctx.studio, ctx.id);
  assertEquals([state.enabled, state.state, state.message], [
    false,
    "conflicts",
    WAITING,
  ]);
  assertEquals(await refused(ctx, "conflicts"), WAITING);
  assertEquals(
    await refused(ctx, "conflicts", true),
    m.conflictLine({ base: "main" }, ["tracked.txt"]),
    "the tool gets the instruction",
  );
  write(
    ctx.wt,
    "tracked.txt",
    "<<<<<<< HEAD\nchat line\n=======\nmain line\n>>>>>>> main\n",
  ); // "done", markers left in
  runGit(ctx.wt, "add", "-A");
  runGit(ctx.wt, "commit", "--no-edit");
  assertEquals(
    (await m.status(ctx.studio, ctx.id)).state,
    "conflicts",
    "markers keep Merge disabled",
  );
  await refused(ctx, "conflicts");
  assertEquals(show(ctx, "main:tracked.txt"), "main line\n", "main untouched");
  commit(ctx.wt, "tracked.txt", "chat line\nmain line\n", "really resolved");
  assert((await m.status(ctx.studio, ctx.id)).enabled);
  assertEquals((await merge(ctx.studio, ctx.id, "T")).state, "merged");
  assertEquals(show(ctx, "main:tracked.txt"), "chat line\nmain line\n");
  assertEquals(box.status(ctx.wt), "");
});

Deno.test("a resolved merge of a conflict lands with the resolution; the tool gets the instruction, no hidden prompt", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "tracked.txt", "chat line\n", "chat edit");
  commit(ctx.wt, "extra.txt", "x\n", "chat extra");
  commit(box.project, "tracked.txt", "main line\n", "main edit");
  const answer = await merge(ctx.studio, ctx.id, "T", true);
  assertEquals(answer.state, "conflicts");
  assert(
    (answer.message as string).includes("tracked.txt") &&
      (answer.message as string).includes("conflict marker"),
  );
  assertEquals(
    ctx.studio.prompts(),
    [],
    "no prompt is queued behind the running turn",
  );
  write(ctx.wt, "tracked.txt", "both\n");
  runGit(ctx.wt, "add", "-A");
  runGit(ctx.wt, "commit", "--no-edit");
  assertEquals((await merge(ctx.studio, ctx.id, "T")).state, "merged");
  assertEquals([show(ctx, "main:tracked.txt"), show(ctx, "main:extra.txt")], [
    "both\n",
    "x\n",
  ]);
});

Deno.test("a prompt the chat does not accept is refused with its error", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "tracked.txt", "chat line\n", "chat edit");
  commit(box.project, "tracked.txt", "main line\n", "main edit");
  ctx.studio.answer = [409, { error: "The chat is closed" }];
  assertEquals(
    await refused(ctx, "prompt_failed"),
    "Could not ask the chat to resolve the conflicts: The chat is closed",
  );
});

// ---- the user's edits in the project folder -----------------------------------------------------------------------------
Deno.test("other stashes are never touched", async () => {
  using box = new Sandbox();
  write(box.project, "tracked.txt", "one\nstashed by the user\n");
  runGit(box.project, "stash", "push", "-m", "users own stash");
  const before = box.stashes();
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n");
  write(box.project, "tracked.txt", "one\nlater edit\n");
  await merge(ctx.studio, ctx.id, "T");
  assertEquals(box.stashes(), before);
  assertEquals(read(box.project, "tracked.txt"), "one\nlater edit\n");
});

Deno.test("a failure before the merge lands restores the user's edits exactly", async () => {
  using box = new Sandbox();
  write(box.project, "tracked.txt", "one\nuser edit\n");
  write(box.project, "fresh.txt", "untracked\n");
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n");
  const [statusBefore, mainBefore, branchBefore] = [
    box.status(),
    main(ctx),
    runGit(ctx.wt, "rev-parse", "HEAD"),
  ];
  m.HOOKS.before_ff = () => {
    throw new Error("boom");
  };
  try {
    const error = await assertRejects(() => merge(ctx.studio, ctx.id, "T"));
    assertEquals(error.message, "boom");
  } finally {
    delete m.HOOKS.before_ff;
  }
  assertEquals(box.status(), statusBefore);
  assertEquals([
    read(box.project, "tracked.txt"),
    read(box.project, "fresh.txt"),
  ], ["one\nuser edit\n", "untracked\n"]);
  assertEquals(
    [box.stashes(), main(ctx), runGit(ctx.wt, "rev-parse", "HEAD")],
    [[], mainBefore, branchBefore],
  );
  assertEquals(
    runGit(ctx.wt, "symbolic-ref", "HEAD").trim(),
    "refs/heads/studio/chat-aaaaaaaa",
  );
  assertEquals(
    await pythonProbe(box.state, box.project, record(ctx), "settle"),
    { pause: "free", worktree: "free", paused: false },
  );
});

Deno.test("base moving during the merge is no half merge", async () => {
  using box = new Sandbox();
  write(box.project, "tracked.txt", "one\nuser edit\n");
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n");
  m.HOOKS.before_ff = () =>
    runGit(box.project, "commit", "--allow-empty", "-m", "moved under us");
  try {
    assertEquals(
      (await refused(ctx, "ff_failed")).split(":")[0],
      "Could not fast-forward main",
    );
  } finally {
    delete m.HOOKS.before_ff;
  }
  assertEquals(
    runGit(box.project, "log", "--format=%s", "-1").trim(),
    "moved under us",
  );
  assert(!tree(ctx).includes("committed.txt"));
  assertEquals([
    read(box.project, "tracked.txt"),
    box.stashes(),
    box.status(ctx.wt),
  ], ["one\nuser edit\n", [], ""]);
  assertEquals(
    (await merge(ctx.studio, ctx.id, "T")).state,
    "merged",
    "asking again re-reads main and goes through",
  );
});

// ---- guards ------------------------------------------------------------------------------------------------------------
Deno.test("index.lock or a merge in progress in the base folder is refused and nothing changes", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n");
  const lock = pathOf(box.project, ".git", "index.lock");
  Deno.writeTextFileSync(lock, "");
  const before = main(ctx);
  const text = await refused(ctx, "locked");
  assertEquals(
    text,
    "Git is busy in the folder that has the base branch (index.lock exists)",
  );
  Deno.removeSync(lock);
  Deno.writeTextFileSync(pathOf(box.project, ".git", "MERGE_HEAD"), before);
  assert((await refused(ctx, "locked")).includes("merge is in progress"));
  Deno.removeSync(pathOf(box.project, ".git", "MERGE_HEAD"));
  assertEquals(main(ctx), before);
  assertEquals((await merge(ctx.studio, ctx.id, "T")).state, "merged");
});

Deno.test("a busy chat is refused by the direct merge but its own tool may merge", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n", "agent commit");
  ctx.studio.states.set(ctx.id, {
    ...ctx.studio.states.get(ctx.id)!,
    state: "prompting",
    busy: true,
  });
  assertEquals(
    await refused(ctx, "busy"),
    "Wait for the chat to finish its turn",
  );
  const state = await m.status(ctx.studio, ctx.id);
  assertEquals([state.enabled, state.state], [true, "ready"], "the button asks the agent: its message is queued");
  const result = await merge(ctx.studio, ctx.id, "T", true);
  assertEquals(result.message, "Merged into main (1 commit)");
  assertEquals(show(ctx, "main:committed.txt"), "a\n");
});

Deno.test("queued messages, terminals, subagents and a closed chat are refused", () => {
  const reason = (state: Record<string, unknown>) =>
    m.stateIdleReason({ state: "ready", busy: false, ...state });
  assertEquals(reason({}), "");
  assertEquals(
    reason({ queue: { items: [{ id: "q" }] } }),
    "Messages are queued in this chat",
  );
  assertEquals(
    m.stateIdleReason({ state: "ready", queue: { items: [1] } }, true, false),
    "",
  );
  assert(
    reason({ clientCaps: { terminals: [{ status: "running" }] } }).includes(
      "terminal",
    ),
  );
  assertEquals(
    reason({ clientCaps: { terminals: [{ status: "exited" }] } }),
    "",
  );
  assert(
    reason({ subagents: { c1: { state: "running" } } }).includes("subagent"),
  );
  assert(
    reason({ subagents: { c1: { state: "In Progress" } } }).includes(
      "subagent",
    ),
  );
  assertEquals(reason({ subagents: { c1: { state: "completed" } } }), "");
  assert(reason({ closed: true }).includes("closed"));
  assertEquals(
    m.stateIdleReason({ state: "prompting", busy: true }, false),
    "",
  );
});

Deno.test("two merges racing: one wins and the other looks again", async () => {
  using box = new Sandbox();
  const first = await chat(box, "c1", "a".repeat(32));
  const second = await chat(box, "c2", "b".repeat(32), first.studio);
  commit(first.wt, "one.txt", "1\n", "first work");
  commit(second.wt, "two.txt", "2\n", "second work");
  let count = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  m.HOOKS.before_lock = async () => {
    count++;
    if (count === 2) open();
    if (count <= 2) await gate; // both have read the same tip before either takes the lock
  };
  try {
    const results = await Promise.all([
      merge(first.studio, "c1", "T"),
      merge(first.studio, "c2", "T"),
    ]);
    assertEquals(results.map((r) => r.state), ["merged", "merged"]);
  } finally {
    delete m.HOOKS.before_lock;
  }
  assert(count >= 3, "the loser went round again");
  assert(tree(first).includes("one.txt") && tree(first).includes("two.txt"));
  const subjects = runGit(box.project, "log", "--format=%s", "main");
  assert(subjects.includes("first work") && subjects.includes("second work"));
});

Deno.test("a merge already running for the chat is refused; non-worktree and unknown chats are told so", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "committed.txt", "a\n");
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atHook = new Promise<void>((resolve) => (reached = resolve));
  m.HOOKS.before_lock = async () => {
    reached();
    await wait;
  };
  const running = merge(ctx.studio, ctx.id, "T");
  await atHook;
  try {
    assertEquals(
      await refused(ctx, "running"),
      "A merge of this chat is already running",
    );
    assertEquals((await m.status(ctx.studio, ctx.id)).state, "merging");
    assertEquals((await m.status(ctx.studio, ctx.id)).message, "Merging…");
  } finally {
    delete m.HOOKS.before_lock;
    release();
  }
  assertEquals((await running).state, "merged");
  ctx.studio.add("plain", box.project);
  assertEquals(await m.status(ctx.studio, "plain"), { worktree: false });
  const plain = { ...ctx, id: "plain" };
  assertEquals(
    await refused(plain, "no_worktree"),
    "This chat does not work in its own worktree",
  );
  assertEquals(await m.status(ctx.studio, "nope"), { worktree: false });
  assertEquals(
    await refused({ ...ctx, id: "nope" }, "unknown_chat"),
    "Open the chat to merge its work",
  );
  const error = await assertRejects(
    () => merge(ctx.studio, "", "T"),
    Refused,
  ) as m.Refused;
  assertEquals([error.code, error.status, error.message], [
    "bad_request",
    400,
    "Choose a chat",
  ]);
  Deno.removeSync(ctx.wt, { recursive: true });
  // a removed folder: the record no longer matches a ready worktree on disk
  assertEquals((await m.status(ctx.studio, ctx.id)).worktree, true);
  assertEquals((await m.status(ctx.studio, ctx.id)).state, "unavailable");
});
