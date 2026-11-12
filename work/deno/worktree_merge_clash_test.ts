/**
 * server/worktrees/merge.ts, second half of worktree_merge_test.ts (split so the two halves run in parallel): clashes when
 * re-applying the user's edits (test_worktree_e2.py), synced edits and sync clashes (test_worktree_userbase.py, test_worktree_g3.py),
 * the cross-process locks, wording and parity with Python on identical repos (same result, same commits, same registry record, same
 * live calls).
 */
import { assert, assertEquals, assertRejects } from "./_assert.ts";
import { PyParity } from "./_parity.ts";
import { commit, FakeStudio, FIXED_DATES, makeRepo, pythonHolds, pythonProbe, read, runGit, Sandbox, setFixedDates, write } from "./_worktree_fixtures.ts";
import { chat, type Ctx, main, merge, record, refused, Refused, show, tree, WAITING } from "./_merge_fixtures.ts";
import * as wt from "../../outputs/agent-studio/server/worktrees/worktrees.ts";
import * as m from "../../outputs/agent-studio/server/worktrees/merge.ts";
import { pathOf } from "../../outputs/agent-studio/server/state/paths.ts";

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
    message.includes("AIB: work from chat My chat") &&
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
      "AIB is busy with this chat's workspace; try Merge again",
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
        const { path: _p, project: _q, pid: _i, created: _c, editsFrom: _e, ...rest } = r; // editsFrom: Deno only
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
