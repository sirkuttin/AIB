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
import { PyParity } from "./_parity.ts";
import {
  commit,
  FakeStudio,
  FIXED_DATES,
  makeRepo,
  pythonHolds,
  pythonProbe,
  read,
  runGit,
  Sandbox,
  setFixedDates,
  write,
} from "./_worktree_fixtures.ts";
import * as wt from "../../outputs/agent-studio/server/worktrees/worktrees.ts";
import * as m from "../../outputs/agent-studio/server/worktrees/merge.ts";
import { pathOf } from "../../outputs/agent-studio/server/state/paths.ts";

const { merge, Refused, WAITING } = m;

interface Ctx {
  box: Sandbox;
  studio: FakeStudio;
  manager: wt.Manager;
  wt: string;
  id: string;
  key: string;
}

async function chat(
  box: Sandbox,
  id = "c1",
  key = "a".repeat(32),
  studio?: FakeStudio,
): Promise<Ctx> {
  runGit(box.project, "config", "core.autocrlf", "false"); // the helpers commit with autocrlf off: keep checkouts byte for byte
  const manager = new wt.Manager(box.state);
  const plan = (await manager.plan(box.project, key))!;
  await manager.create(plan);
  studio ??= new FakeStudio(box.state);
  studio.add(id, plan.path);
  return { box, studio, manager, wt: plan.path, id, key };
}

async function refused(
  ctx: Ctx,
  code: string,
  fromTool = false,
): Promise<string> {
  const error = await assertRejects(
    () => merge(ctx.studio, ctx.id, "T", fromTool),
    Refused,
  ) as m.Refused;
  assertEquals(error.code, code, error.message);
  return error.message;
}

function record(ctx: Ctx): wt.WorktreeRecord & { key: string } {
  return { ...ctx.manager.registry.get(ctx.key)!, key: ctx.key };
}

const main = (ctx: Ctx) => runGit(ctx.box.project, "rev-parse", "main").trim();
const tree = (ctx: Ctx, ref = "main") =>
  runGit(ctx.box.project, "ls-tree", "-r", "--name-only", ref).split("\n")
    .filter(Boolean);
const show = (ctx: Ctx, spec: string) => runGit(ctx.box.project, "show", spec);

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
  assertEquals(log.sort(), ["Studio: work from chat My title", "agent commit"]);
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

Deno.test("a busy chat is refused by the button but its own tool may merge", async () => {
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
  assertEquals([state.enabled, state.state], [false, "busy"]);
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

// ---- clashes when re-applying the user's edits (test_worktree_e2.py) ---------------------------------------------------
async function clashed(box: Sandbox, provider = "claude") {
  write(box.project, "tracked.txt", "user line\n"); // in S, uncommitted in main
  write(box.project, "mine.txt", "user only\n"); // a clean edit of the user: applies without a clash
  const ctx = await chat(box);
  ctx.studio.states.get(ctx.id)!.provider = provider;
  commit(ctx.wt, "tracked.txt", "chat line\n", "chat edit");
  const result = await merge(ctx.studio, ctx.id, "T");
  assertEquals([result.state, result.clash], ["merged", ["tracked.txt"]]);
  return { ctx, result };
}

Deno.test("overlapping edits clash: the stash is kept, the note names it with two buttons, the idle chat is told", async () => {
  using box = new Sandbox();
  const { ctx, result } = await clashed(box);
  const stashes = box.stashes();
  assertEquals(stashes.length, 1);
  assert(
    stashes[0].includes(result.stash as string) &&
      (result.stash as string).startsWith("studio-merge-chat-aaaaaaaa-"),
  );
  assertEquals(
    show(ctx, "stash@{0}:tracked.txt"),
    "user line\n",
    "the user's work is in the stash",
  );
  assert(
    read(box.project, "tracked.txt").includes("<<<<<<<"),
    "git's own conflict state is left for the user",
  );
  const notes = ctx.studio.calls.filter(([op]) => op === m.NOTE_OP).map((
    [, p],
  ) => p);
  assertEquals(notes[0], {
    message: "Merged into main (1 commit)",
    id: ctx.id,
  });
  assertEquals(
    notes[1].message,
    m.clashNote(["tracked.txt"], result.stash as string),
  );
  assertEquals(notes[1].actions, [
    { id: "keep-mine", label: "Keep my version" },
    { id: "leave", label: "I'll sort it myself" },
  ]);
  const told = ctx.studio.prompts().at(-1)!;
  for (
    const word of [
      "tracked.txt",
      result.stash as string,
      "Offer to combine",
      box.project,
      '"check"',
      "Keep my version",
    ]
  ) assert(told.includes(word), word);
  assertEquals(told, result.guidance);
  const status = await m.clashStatus(ctx.studio, box.project);
  assertEquals(status, {
    unresolved: true,
    line: "tracked.txt has unresolved edits. Ask the chat to fix it.",
    files: ["tracked.txt"],
    stash: result.stash,
  });
  assertEquals(await m.clashStatus(ctx.studio, pathOf(box.base, "elsewhere")), {
    unresolved: false,
  });
  const saved = JSON.parse(
    Deno.readTextFileSync(pathOf(box.state, m.CLASH_FILE)),
  );
  assertEquals(
    Object.values(saved).map((r) => (r as Record<string, unknown>).files),
    [["tracked.txt"]],
  );
});

Deno.test("an adapter that cannot write in the project skips the combine step", async () => {
  assert(m.canEditProject({ provider: "claude" }));
  assert(!m.canEditProject({ provider: "codex" }));
  const chat = { base: "main", project: "P" };
  assert(
    m.clashGuidance(chat, ["a.md"], "s", true).includes("Offer to combine"),
  );
  const without = m.clashGuidance(chat, ["a.md"], "s", false);
  assert(
    !without.includes("Offer to combine") && without.includes("keep_mine"),
  );
  using box = new Sandbox();
  const { result } = await clashed(box, "codex");
  assert(!(result.guidance as string).includes("Offer to combine"));
});

Deno.test('the amber line clears when the chat combines the files ("check")', async () => {
  using box = new Sandbox();
  const { ctx } = await clashed(box);
  const error = await assertRejects(
    () => m.resolveClash(ctx.studio, ctx.id, "check"),
    Refused,
  ) as m.Refused;
  assertEquals(error.code, "markers");
  assert((await m.clashStatus(ctx.studio, box.project)).unresolved);
  write(box.project, "tracked.txt", "chat line\nuser line\n");
  const done = await m.resolveClash(ctx.studio, ctx.id, "check");
  assert((done.message as string).includes("tracked.txt"));
  assertEquals(await m.clashStatus(ctx.studio, box.project), {
    unresolved: false,
  });
  assertEquals(runGit(box.project, "ls-files", "-u"), "");
  assertEquals(read(box.project, "tracked.txt"), "chat line\nuser line\n");
  assertEquals(
    box.stashes().length,
    1,
    "combining keeps the stash as a backup",
  );
  assertEquals(ctx.studio.notes().at(-1), done.message);
});

Deno.test("keep my version restores the user's side and drops the stash when fully applied", async () => {
  using box = new Sandbox();
  const { ctx, result } = await clashed(box);
  const done = await m.resolveClash(ctx.studio, ctx.id, "keep_mine");
  assertEquals([done.dropped, done.files, done.message], [
    true,
    ["tracked.txt"],
    `Kept your version of tracked.txt. The stash ${result.stash} was dropped.`,
  ]);
  assertEquals([
    read(box.project, "tracked.txt"),
    read(box.project, "mine.txt"),
  ], ["user line\n", "user only\n"]);
  assertEquals([box.stashes(), runGit(box.project, "ls-files", "-u")], [
    [],
    "",
  ]);
  assertEquals(
    show(ctx, "main:tracked.txt"),
    "chat line\n",
    "main itself holds the merged work",
  );
  assertEquals(await m.clashStatus(ctx.studio, box.project), {
    unresolved: false,
  });
  const error = await assertRejects(
    () => m.resolveClash(ctx.studio, ctx.id, "keep-mine"),
    Refused,
  ) as m.Refused;
  assertEquals([error.code, error.message], [
    "no_clash",
    "There are no unresolved edits in this project",
  ]);
});

Deno.test("keep my version keeps the stash when it is not fully applied; leave changes nothing; bad actions are refused", async () => {
  using box = new Sandbox();
  const { ctx, result } = await clashed(box);
  const snapshot = () => [
    box.status(),
    box.stashes(),
    read(box.project, "tracked.txt"),
    main(ctx),
  ];
  const before = snapshot();
  const left = await m.resolveClash(ctx.studio, ctx.id, "leave");
  assert((left.message as string).includes(result.stash as string));
  assertEquals(snapshot(), before);
  assert(
    (await m.clashStatus(ctx.studio, box.project)).unresolved,
    "the amber line stays until it is really resolved",
  );
  wt.testing.git = (args, cwd, options) =>
    args[0] === "checkout"
      ? Promise.resolve({
        returncode: 1,
        stdout: "",
        stderr: "boom",
        out: new Uint8Array(),
      })
      : wt.realGit(args, cwd, options);
  try {
    const done = await m.resolveClash(ctx.studio, ctx.id, "keep-mine");
    assertEquals(done.dropped, false);
  } finally {
    wt.testing.git = null;
  }
  assertEquals(box.stashes().length, 1);
  assert((await m.clashStatus(ctx.studio, box.project)).unresolved);
  const bad = await assertRejects(
    () => m.resolveClash(ctx.studio, ctx.id, "nope"),
    Refused,
  ) as m.Refused;
  assertEquals([bad.code, bad.status], ["bad_request", 400]);
  write(box.project, "tracked.txt", "by hand\n"); // the user resolves it by hand
  assert(
    (await m.clashStatus(ctx.studio, box.project)).unresolved,
    "git still has an unmerged entry",
  );
  runGit(box.project, "add", "tracked.txt");
  assertEquals(await m.clashStatus(ctx.studio, box.project), {
    unresolved: false,
  });
});

Deno.test("a clash from a merge by the tool returns the guidance and posts no second prompt", async () => {
  using box = new Sandbox();
  write(box.project, "tracked.txt", "user line\n");
  const ctx = await chat(box);
  commit(ctx.wt, "tracked.txt", "chat line\n", "chat edit");
  const result = await merge(ctx.studio, ctx.id, "T", true);
  assert((result.guidance as string).includes("Offer to combine"));
  assertEquals(ctx.studio.prompts(), []);
});

// ---- the user base U and tree landing (test_worktree_userbase.py) ---------------------------------------------------------
const LINES = "a\nb\nc\nd\ne\nf\n";

async function syncedChat(box: Sandbox): Promise<Ctx> {
  commit(box.project, "f.txt", LINES, "add f");
  const ctx = await chat(box);
  write(box.project, "f.txt", "A-user\nb\nc\nd\ne\nf\n"); // what live sync does: U moves and the worktree gets the file
  await wt.advanceUserBase(record(ctx), ["f.txt"], ctx.manager.registry);
  write(ctx.wt, "f.txt", "A-user\nb\nc\nd\ne\nf\n");
  return ctx;
}

Deno.test("synced edits are not changes; only the chat's lines land and the folder keeps the user's edit", async () => {
  using box = new Sandbox();
  const ctx = await syncedChat(box);
  const state = await m.status(ctx.studio, ctx.id);
  assertEquals([state.enabled, state.state], [false, "nochanges"]);
  assert(!(await ctx.manager.hasChanges(record(ctx))), "Archive may remove it");
  await refused(ctx, "empty"); // Merge commits the synced line itself; it is U's, so nothing of the chat's lands
  write(ctx.wt, "f.txt", "A-user\nb\nc\nd\ne\nf-chat\n");
  runGit(ctx.wt, "commit", "-a", "-m", "chat edits f");
  const statusBefore = box.status();
  const result = await merge(ctx.studio, ctx.id, "My chat");
  assertEquals([result.state, result.commits], ["merged", 2]); // that commit and the chat's, landed as one
  assertEquals(
    show(ctx, "main:f.txt"),
    "a\nb\nc\nd\ne\nf-chat\n",
    "the user's synced line never lands",
  );
  const message = runGit(box.project, "log", "-1", "--format=%B", "main");
  assert(
    message.includes("Studio: work from chat My chat") &&
      message.includes("- chat edits f"),
  );
  assertEquals(
    runGit(box.project, "rev-list", "--count", "main").trim(),
    "3",
    "one commit on top, no snapshot commits",
  );
  assertEquals(read(box.project, "f.txt"), "A-user\nb\nc\nd\ne\nf-chat\n");
  assertEquals([box.stashes(), box.status()], [[], statusBefore]);
  const rec = record(ctx);
  assertEquals(rec.snapshot, main(ctx));
  assert(rec.user !== main(ctx), "U is the tip plus the user's unsaved edits");
  assertEquals([rec.diffBase, runGit(ctx.wt, "rev-parse", "HEAD").trim()], [
    rec.user,
    rec.user,
  ]);
  assertEquals(
    runGit(box.project, "rev-parse", "refs/studio/chat-aaaaaaaa/user").trim(),
    rec.user,
  );
  assertEquals(read(ctx.wt, "f.txt"), "A-user\nb\nc\nd\ne\nf-chat\n");
  commit(ctx.wt, "g.txt", "second\n", "more");
  assertEquals((await merge(ctx.studio, ctx.id, "T")).state, "merged");
  assertEquals([show(ctx, "main:f.txt"), show(ctx, "main:g.txt")], [
    "a\nb\nc\nd\ne\nf-chat\n",
    "second\n",
  ]);
});

Deno.test("a merge-tree conflict refuses cleanly and tells the chat", async () => {
  using box = new Sandbox();
  const ctx = await syncedChat(box);
  write(ctx.wt, "f.txt", "a-chat\nb\nc\nd\ne\nf\n"); // the same line the user edited
  runGit(ctx.wt, "commit", "-a", "-m", "chat edits a");
  const [mainBefore, statusBefore] = [main(ctx), box.status()];
  const result = await merge(ctx.studio, ctx.id, "T");
  assertEquals([result.state, result.files, result.message], ["conflicts", [
    "f.txt",
  ], WAITING]);
  assertEquals(
    ctx.studio.prompts().at(-1),
    m.treeConflictLine(null, ["f.txt"]),
  );
  assertEquals([
    main(ctx),
    box.status(),
    read(box.project, "f.txt"),
    box.stashes(),
  ], [mainBefore, statusBefore, "A-user\nb\nc\nd\ne\nf\n", []]);
  const answer = await merge(ctx.studio, ctx.id, "T", true);
  assertEquals(answer.state, "conflicts");
  assert((answer.message as string).includes("f.txt"));
  write(ctx.wt, "f.txt", "A-user\nb\nc\nd\ne\nf-chat\n");
  runGit(ctx.wt, "commit", "-a", "-m", "rework");
  assertEquals((await merge(ctx.studio, ctx.id, "T")).state, "merged");
  assertEquals(show(ctx, "main:f.txt"), "a\nb\nc\nd\ne\nf-chat\n");
});

Deno.test("autocrlf noise is nothing to merge and nothing to commit", async () => {
  using box = new Sandbox();
  commit(box.project, "f.txt", LINES, "add f");
  const ctx = await chat(box);
  runGit(box.project, "config", "core.autocrlf", "true");
  write(ctx.wt, "tracked.txt", "one\r\n");
  write(ctx.wt, "f.txt", LINES.replaceAll("\n", "\r\n"));
  assertEquals((await m.status(ctx.studio, ctx.id)).state, "nochanges");
  assert(!(await m.commitPending(await m.Chat.open(ctx.studio, ctx.id), "T")));
});

// ---- locks across processes ----------------------------------------------------------------------------------------------
Deno.test("another process holding the locks stops merge; merge holds both while it lands and drops them after", async () => {
  using box = new Sandbox();
  const ctx = await chat(box);
  commit(ctx.wt, "g.txt", "chat\n", "chat file");
  const rec = record(ctx);
  const saved = m.settings.LOCK_WAIT;
  m.settings.LOCK_WAIT = 0.3;
  const holder = await pythonHolds(box.state, box.project, rec);
  try {
    assert(await wt.syncPaused(box.state, box.project));
    assertEquals(
      await refused(ctx, "busy"),
      "Studio is busy with this chat's workspace; try Merge again",
    );
    assert(!tree(ctx).includes("g.txt"));
  } finally {
    await holder.release();
    m.settings.LOCK_WAIT = saved;
  }
  let seen: unknown = null;
  m.HOOKS.before_ff = async () => {
    seen = await pythonProbe(box.state, box.project, rec, "probe");
  };
  try {
    assertEquals((await merge(ctx.studio, ctx.id, "T")).state, "merged");
  } finally {
    delete m.HOOKS.before_ff;
  }
  assertEquals(seen, { pause: "held", worktree: "held", paused: true });
  assertEquals(await pythonProbe(box.state, box.project, rec, "probe"), {
    pause: "free",
    worktree: "free",
    paused: false,
  });
});

// ---- the sync helpers Merge calls (test_worktree_g3.py) --------------------------------------------------------------
Deno.test("an unresolved sync clash blocks Merge; resolving it advances U and clears it", async () => {
  using box = new Sandbox();
  commit(box.project, "f.txt", LINES, "add f");
  const ctx = await chat(box);
  const before = record(ctx).user;
  write(box.project, "f.txt", "a\nb\nc\nd\ne\nf-user\n"); // the user's save, merged into the copy with a clash
  write(
    ctx.wt,
    "f.txt",
    "<<<<<<< chat\nf-chat\n=======\nf-user\n>>>>>>> user\n",
  );
  const userBlob = runGit(box.project, "hash-object", "f.txt").trim();
  await ctx.manager.registry.update(ctx.key, {
    syncConflicts: ["f.txt"],
    syncMerged: { "f.txt": userBlob, other: "x" },
    pendingSync: ["p.txt"],
  });
  assertEquals(m.openClashes(record(ctx)), ["f.txt"]);
  const status = await m.status(ctx.studio, ctx.id);
  assertEquals([status.enabled, status.state, status.message], [
    false,
    "conflicts",
    m.clashLine(["f.txt"]),
  ]);
  assertEquals(await refused(ctx, "conflicts"), m.clashLine(["f.txt"]));
  assertEquals(
    record(ctx).user,
    before,
    "U moves only when the clash is resolved",
  );
  write(ctx.wt, "f.txt", "a\nb\nc\nd\ne\nf-both\n");
  assertEquals((await m.status(ctx.studio, ctx.id)).state, "ready");
  assertEquals(await m.settleConflicts(ctx.manager.registry, record(ctx)), []);
  const rec = record(ctx);
  assertEquals([rec.syncConflicts, rec.syncMerged, rec.pendingSync], [[], {
    other: "x",
  }, ["p.txt"]]);
  assert(rec.user !== before);
  assertEquals(show(ctx, `${rec.user}:f.txt`), "a\nb\nc\nd\ne\nf-user\n");
  const after = await merge(ctx.studio, ctx.id, "T"); // f-both rewrote the user's line: landing it may clash (stage E2), never a sync clash
  assert(["merged", "conflicts"].includes(after.state as string));
  assertEquals(record(ctx).syncConflicts, []);
});

Deno.test("a user save after the clash goes back to pendingSync instead of moving U", async () => {
  using box = new Sandbox();
  commit(box.project, "f.txt", LINES, "add f");
  const ctx = await chat(box);
  const before = record(ctx).user;
  write(box.project, "f.txt", "a\nb\nc\nd\ne\nf-user\n");
  const blob = runGit(box.project, "hash-object", "f.txt").trim();
  write(box.project, "f.txt", "a\nb\nc\nd\ne\nf-user2\n");
  write(ctx.wt, "f.txt", "a\nb\nc\nd\ne\nf-both\n");
  await ctx.manager.registry.update(ctx.key, {
    syncConflicts: ["f.txt"],
    syncMerged: { "f.txt": blob },
  });
  assertEquals(await m.settleConflicts(ctx.manager.registry, record(ctx)), []);
  const rec = record(ctx);
  assertEquals([rec.user, rec.syncConflicts, rec.pendingSync], [before, [], [
    "f.txt",
  ]]);
});

Deno.test("the storm pause shows on the amber line", () => {
  using box = new Sandbox(false);
  const project = pathOf(box.base, "my-proj");
  assertEquals(m.pausedStatus(box.state, project), {});
  Deno.mkdirSync(box.state, { recursive: true });
  const key = wt.norm(project);
  Deno.writeTextFileSync(
    pathOf(box.state, m.SYNC_FILE),
    JSON.stringify({ [key]: { paused: true, project, count: 300, time: 1 } }),
  );
  assertEquals(m.pausedStatus(box.state, project), {
    syncPaused: true,
    syncLine: "Lots of files changed in my-proj; live sync paused. Resume?",
  });
});

// ---- small pieces vs Python -------------------------------------------------------------------------------------------
Deno.test("commit messages, conflict lines, markers and idle reasons match Python", async () => {
  await using py = new PyParity();
  for (
    const title of [
      "",
      null,
      "My title",
      "  spaced\t\nout  ",
      "x".repeat(100),
      "ü😀".repeat(50),
      7,
    ]
  ) {
    assertEquals(
      m.commitMessage(title),
      await py.call("worktree_merge", "commit_message", [title]),
      String(title),
    );
  }
  const files = Array.from({ length: 14 }, (_, i) => `f${i}.txt`);
  for (const list of [["a"], files]) {
    assertEquals(
      m.clashNote(list, "s"),
      await py.call("worktree_merge", "clash_note", [list, "s"]),
    );
    assertEquals(
      m.clashLine(list),
      await py.call("worktree_sync", "clash_line", [list]),
    );
    assertEquals(
      m.treeConflictLine(null, list),
      await py.call("worktree_merge", "tree_conflict_line", [null, list]),
    );
  }
  for (
    const text of [
      "<<<<<<< HEAD\n",
      "x\n>>>>>>> main",
      "<<<<<<<\r\n",
      "<<<<<<<\rX",
      "a\r<<<<<<< x",
      "=======\n",
      " <<<<<<< x",
      "<<<<<<<<",
      ">>>>>>>",
    ]
  ) {
    const expected = await py.call("worktree_merge", "MARKER.search", [text]);
    assertEquals(m.MARKER.test(text), expected !== null, JSON.stringify(text));
  }
  const states = [
    {},
    { state: "ready" },
    { state: "ready", busy: true },
    { state: "ready", closed: 1 },
    { state: "ready", queue: { items: [] } },
    { state: "ready", queue: { items: [1] } },
    { state: "ready", clientCaps: { terminals: [{ status: "running" }] } },
    { state: "ready", subagents: { a: { state: "Streaming" }, b: "x" } },
    { state: "ready", subagents: { a: { state: 5 } } },
  ];
  for (const state of states) {
    for (const [busy, queue] of [[true, true], [false, true], [false, false]]) {
      assertEquals(
        m.stateIdleReason(state, busy, queue),
        await py.call("worktree_merge", "state_idle_reason", [
          state,
          busy,
          queue,
        ]),
        JSON.stringify(state),
      );
    }
  }
  assertEquals(
    m.clashActions(),
    await py.call("worktree_merge", "clash_actions"),
  );
});

// ---- parity: the same merges on identical repos ----------------------------------------------------------------------------
Deno.test("parity: merges, conflicts, tree landing and clashes give the same results, commits and records as Python", async () => {
  await using py = new PyParity();
  using box = new Sandbox(false);
  setFixedDates(true);
  await py.call("worktrees_shim", "set_env", [FIXED_DATES]);
  try {
    const key = "0123456789abcdef0123456789abcdef";
    const sides = ["py", "deno"].map((name) => {
      const project = makeRepo(pathOf(box.base, name, "proj"));
      runGit(project, "config", "core.autocrlf", "false");
      commit(project, "f.txt", LINES, "add f");
      write(project, "tracked.txt", "user line\n"); // in S: clashes with the chat's edit when re-applied
      write(project, "mine.txt", "user only\n");
      return { name, project, state: pathOf(box.base, name, "state"), wt: "" };
    });
    const [pySide, denoSide] = sides;
    const pyPlan = await py.call("worktrees_shim", "manager", [
      pySide.state,
      "plan",
      [pySide.project, key],
    ]) as Record<string, unknown>;
    await py.call("worktrees_shim", "manager", [pySide.state, "create", [
      pyPlan,
    ]]);
    pySide.wt = pyPlan.path as string;
    const manager = new wt.Manager(denoSide.state);
    const plan = (await manager.plan(denoSide.project, key))!;
    await manager.create(plan);
    denoSide.wt = plan.path;
    const studio = new FakeStudio(denoSide.state);
    studio.add("c1", denoSide.wt);
    const pyState = {
      state: "ready",
      busy: false,
      cwd: pySide.wt,
      provider: "claude",
    };
    const scrub = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value).replace(
          /"clientMessageId":"[^"]*"/g,
          '"clientMessageId":"*"',
        ).replace(
          /studio-merge-chat-01234567-\d+/g,
          "STASH",
        )
          .replaceAll(JSON.stringify(pySide.project).slice(1, -1), "PROJ")
          .replaceAll(JSON.stringify(denoSide.project).slice(1, -1), "PROJ"),
      );
    const both = async (
      step: (side: typeof pySide) => void,
      op = "merge",
      args: unknown[] = ["T"],
    ) => {
      for (const side of sides) step(side);
      const fromPy = await py.call("worktrees_shim", "merge", [
        pySide.state,
        "c1",
        pyState,
        op,
        args,
      ]) as Record<string, unknown>;
      studio.calls.length = 0;
      let fromDeno: Record<string, unknown>;
      try {
        const fn = op === "merge"
          ? m.merge
          : op === "status"
          ? m.status
          : m.resolveClash;
        fromDeno = {
          result: await (fn as (...a: unknown[]) => Promise<unknown>)(
            studio,
            "c1",
            ...args,
          ),
        };
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        fromDeno = { refused: [error.code, error.status, error.message] };
      }
      fromDeno.calls = studio.calls.map(([o, p]) => [o, p]);
      assertEquals(
        scrub(fromDeno),
        scrub(fromPy),
        `${op} ${JSON.stringify(args)}`,
      );
      assertEquals(
        runGit(denoSide.project, "rev-parse", "main"),
        runGit(pySide.project, "rev-parse", "main"),
        "same main",
      );
      const strip = (r: Record<string, unknown>) => {
        const { path: _p, project: _q, pid: _i, created: _c, ...rest } = r;
        return rest;
      };
      const pyRecord = await py.call("worktrees_shim", "registry", [
        pySide.state,
        "get",
        [key],
      ]) as Record<string, unknown>;
      assertEquals(
        strip(manager.registry.get(key)!),
        strip(pyRecord),
        "same record",
      );
      const result = fromDeno.result as Record<string, unknown> | undefined;
      trail.push(
        fromDeno.refused
          ? `refused:${(fromDeno.refused as string[])[0]}`
          : String(result?.state ?? (result?.ok ? "ok" : "?")),
      );
      return fromDeno;
    };
    const trail: string[] = [];
    await both(() => {}, "status", []);
    await both(() => {}); // nothing to merge
    await both(
      (s) => {
        commit(s.wt, "committed.txt", "a\n", "agent commit");
        write(s.wt, "late.txt", "late\n");
      },
      "status",
      [],
    );
    await both((s) => commit(s.wt, "tracked.txt", "chat line\n", "chat edit")); // merged, with a clash on re-applying
    await both(() => {}, "status", []);
    await both(() => {}, "resolve_clash", ["leave"]);
    await both(
      (s) => write(s.project, "tracked.txt", "chat line\nuser line\n"),
      "resolve_clash",
      ["check"],
    );
    await both((s) => {
      commit(s.wt, "f.txt", "a\nb\nc\nd\ne\nf-chat\n", "chat f");
      runGit(s.project, "add", "-A");
      runGit(s.project, "commit", "-q", "-m", "user commits");
      commit(s.project, "f.txt", "a\nb\nc\nd\ne\nf-main\n", "main f");
    }); // conflicts: prompt
    await both(() => {}, "merge", ["T", true]); // refused with the instruction for the tool
    await both((s) => {
      write(s.wt, "f.txt", "a\nb\nc\nd\ne\nf-both\n");
      runGit(s.wt, "add", "-A");
      runGit(s.wt, "commit", "-q", "--no-edit");
    }); // resolved: merged
    // tree landing after the user base moved
    for (const side of sides) {
      write(side.project, "f.txt", "A-user\nb\nc\nd\ne\nf-both\n");
    }
    const pyRec = await py.call("worktrees_shim", "registry", [
      pySide.state,
      "get",
      [key],
    ]) as Record<string, unknown>;
    const pyU = await py.call("worktrees_shim", "call", ["advance_user_base", [{
      ...pyRec,
      key,
    }, ["f.txt"]]]);
    await py.call("worktrees_shim", "registry", [
      pySide.state,
      "update",
      [key],
      { user: pyU, diffBase: pyU },
    ]);
    const denoU = await wt.advanceUserBase(record({ manager, key } as Ctx), [
      "f.txt",
    ], manager.registry);
    assertEquals(denoU, pyU);
    await both((s) => {
      write(s.wt, "f.txt", "A-user\nb\nc\nd\ne\nf-chat2\n");
      runGit(s.wt, "commit", "-q", "-a", "-m", "chat edits f again");
    });
    await both((s) => {
      write(s.wt, "f.txt", "a-chat\nb\nc\nd\ne\nf-chat2\n");
      runGit(s.wt, "commit", "-q", "-a", "-m", "same line as the user");
    }); // merge-tree conflict
    assertEquals(trail, [
      "nochanges",
      "refused:empty",
      "ready",
      "merged",
      "nochanges", // the clash is on the project folder (the amber line), not on the button
      "ok",
      "ok",
      "conflicts",
      "refused:conflicts",
      "merged",
      "merged",
      "conflicts",
    ]);
  } finally {
    setFixedDates(false);
    await py.call("worktrees_shim", "set_env", [{
      GIT_AUTHOR_DATE: null,
      GIT_COMMITTER_DATE: null,
    }]);
  }
});

Deno.test("resumeSync clears the pause flag worktree_sync.set_paused wrote, in the same file and format (interop)", async () => {
  await using py = new PyParity();
  const state = Deno.makeTempDirSync({ prefix: "studio-sync-flags-" });
  const project = Deno.makeTempDirSync({ prefix: "studio-sync-project-" });
  const other = Deno.makeTempDirSync({ prefix: "studio-sync-other-" });
  try {
    await py.call("worktree_sync", "set_paused", [state, project, 3]);
    await py.call("worktree_sync", "set_paused", [state, other, 5]);
    assert(m.pauseInfo(state, project) !== null);
    assertEquals(await m.resumeSync(state, project), true);
    assertEquals(
      await py.call("worktree_sync", "pause_info", [state, project]),
      null,
    );
    assert(
      await py.call("worktree_sync", "pause_info", [state, other]) !== null,
      "another project stays paused",
    );
    assertEquals(await m.resumeSync(state, project), false);
    assertEquals(await m.resumeSync(state, ""), false);
    assertEquals(await m.resumeSync(state, 5), false);
    assertEquals(
      await py.call("worktree_sync", "resume", [state, other]),
      true,
    ); // Python reads what Deno wrote
  } finally {
    for (const dir of [state, project, other]) {
      Deno.removeSync(dir, { recursive: true });
    }
  }
});
