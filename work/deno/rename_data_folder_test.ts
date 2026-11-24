/**
 * work/migrate/rename_data_folder.ts (owner decision 2026-11-24): the one-time script that renames AIB's data folder AgentStudio -> AIB.
 * Temp folders only; the real %LOCALAPPDATA%\AgentStudio is never named. A "process holding the folder" is a real child process this
 * test starts (its command line names the temp folder) and ends itself.
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  type Deps,
  findHolders,
  type Opts,
  type ProcInfo,
  realLister,
  rewritePaths,
  run,
  treeStats,
  type WslRun,
} from "../migrate/rename_data_folder.ts";
import { pathOf } from "../../app/server/state/paths.ts";
import { dataDirName } from "../../app/server/wsl/install.ts";

const WIN = Deno.build.os === "windows";
const SEP = WIN ? "\\" : "/";

function temp(): { parent: string; [Symbol.dispose](): void } {
  const parent = Deno.realPathSync(
    Deno.makeTempDirSync({ prefix: "aib-rename-data-" }),
  ).replace(/^\\\\\?\\/, "");
  return {
    parent,
    [Symbol.dispose]() {
      try {
        Deno.removeSync(parent, { recursive: true });
      } catch { /* the OS cleans temp */ }
    },
  };
}

const opts = (parent: string, extra: Partial<Opts> = {}): Opts => ({
  parent,
  current: "AIB",
  legacy: "AgentStudio",
  dryRun: false,
  undo: false,
  wsl: true,
  wslRoot: "/tmp/fake-wsl-root",
  ...extra,
});
const noProcs = () => Promise.resolve([] as ProcInfo[]);
const deps = (extra: Partial<Deps> = {}): Deps => ({
  list: noProcs,
  wslDistros: null,
  wslRun: null,
  now: () => new Date(2026, 10, 24, 9, 8, 7),
  checkNames: false,
  ...extra,
});
const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const git = async (cwd: string, ...args: string[]) => {
  const r = await new Deno.Command("git", {
    args: ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  assert(
    r.success,
    `git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`,
  );
  return new TextDecoder().decode(r.stdout);
};

/** A fake data folder: state files that name the folder, a keeper folder, an agent file, and (when asked) a real git worktree inside it. */
async function fakeData(
  parent: string,
  withWorktree: boolean,
): Promise<{ old: string; repo: string }> {
  const old = pathOf(parent, "AgentStudio");
  Deno.mkdirSync(pathOf(old, "keeper"), { recursive: true });
  Deno.mkdirSync(pathOf(old, "agents", "codex"), { recursive: true });
  Deno.mkdirSync(pathOf(old, "chats"), { recursive: true });
  Deno.writeTextFileSync(
    pathOf(old, "settings.json"),
    JSON.stringify({ theme: "dark" }),
  );
  Deno.writeTextFileSync(
    pathOf(old, "chats", "c1.json"),
    JSON.stringify({
      cwd: pathOf(old, "worktrees", "h1", "wt1"),
      other: pathOf(parent, "AgentStudio.keep"),
      fwd: old.replaceAll("\\", "/") + "/x",
    }),
  );
  Deno.writeTextFileSync(
    pathOf(old, "keeper", "journal.jsonl"),
    JSON.stringify({ cwd: old }) + "\n",
  ); // never rewritten
  Deno.writeTextFileSync(
    pathOf(old, "agents", "codex", "a.json"),
    JSON.stringify({ at: old }),
  ); // never rewritten
  Deno.writeFileSync(pathOf(old, "blob.bin"), new Uint8Array(5000).fill(7));
  const repo = pathOf(parent, "project");
  if (withWorktree) {
    Deno.mkdirSync(repo);
    await git(repo, "init", "-q");
    await git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    Deno.mkdirSync(pathOf(old, "worktrees", "h1"), { recursive: true });
    await git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      "studio/wt1",
      pathOf(old, "worktrees", "h1", "wt1"),
    );
  }
  return { old, repo };
}

Deno.test("dry run prints the plan and changes nothing", async () => {
  using t = temp();
  const { old } = await fakeData(t.parent, false);
  const before = treeStats(old);
  const r = await run(opts(t.parent, { dryRun: true }), deps());
  const text = r.lines.join("\n");
  assertEquals(r.code, 0, text);
  assert(text.includes("dry run"), text);
  assert(text.includes("AgentStudio.old-2026-11-24"), text);
  assert(text.includes("Nothing was changed"), text);
  assertEquals(treeStats(old), before);
  assert(!exists(pathOf(t.parent, "AIB")), "no new folder");
  assert(!exists(pathOf(t.parent, "AgentStudio.old-2026-11-24")), "no backup");
});

Deno.test("refuses while a real process has the folder in its command line, naming it by name and PID; never kills it", async () => {
  using t = temp();
  const { old } = await fakeData(t.parent, false);
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "setTimeout(() => {}, 120000)", old],
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await new Promise((r) => setTimeout(r, 1500)); // let the process start so the list sees it
    const r = await run(opts(t.parent), deps({ list: realLister }));
    const text = r.lines.join("\n");
    assertEquals(r.code, 1, text);
    assert(text.includes(`(PID ${child.pid})`), text);
    assert(text.includes("REFUSED"), text);
    assert(/taskkill|kill/.test(text), "says how to quit it");
    assert(!exists(pathOf(t.parent, "AIB")) && exists(old), "nothing changed");
    // still alive: the script never kills
    assert(
      findHolders(await realLister(), old, false, [Deno.pid]).some((h) =>
        h.p.pid === child.pid
      ),
      "the process is still running",
    );
  } finally {
    try {
      child.kill();
    } catch { /* already gone */ }
    await child.status;
  }
});

Deno.test("refuses for AIB and keeper programs by name, and when the new folder already exists", async () => {
  using t = temp();
  const { old } = await fakeData(t.parent, false);
  const procs: ProcInfo[] = [
    {
      pid: 4242,
      name: "AIB.exe",
      exe: "C:\\Program Files\\AIB\\AIB.exe",
      cmd: "",
      cwd: "",
    },
    {
      pid: 4343,
      name: "AIB-keeper.exe",
      exe: pathOf(old, "keeper-bin", "ab", "AIB-keeper.exe"),
      cmd: "",
      cwd: "",
    },
    {
      pid: 4444,
      name: "notepad.exe",
      exe: "C:\\Windows\\notepad.exe",
      cmd: "",
      cwd: "",
    },
  ];
  const r = await run(
    opts(t.parent),
    deps({ list: () => Promise.resolve(procs), checkNames: true }),
  );
  const text = r.lines.join("\n");
  assertEquals(r.code, 1, text);
  assert(
    text.includes("AIB.exe (PID 4242)") &&
      text.includes("AIB-keeper.exe (PID 4343)"),
    text,
  );
  assert(!text.includes("4444"), text);
  Deno.mkdirSync(pathOf(t.parent, "AIB"));
  const r2 = await run(opts(t.parent), deps());
  assertEquals(r2.code, 1);
  assert(r2.lines.join("\n").includes("already exists"));
  assert(exists(old));
});

Deno.test("copies, verifies, rewrites paths, repairs worktrees, renames the old folder; then undo puts it back", async () => {
  using t = temp();
  const { old, repo } = await fakeData(t.parent, true);
  const before = treeStats(old);
  const asked: { distro: string; args: string[] }[] = [];
  const wslRun: WslRun = (distro, _script, args) => {
    asked.push({ distro, args });
    if (args.length === 3) return Promise.resolve({ code: 0, out: "have\n" }); // check: the helper data is there, nothing runs
    return Promise.resolve({
      code: 0,
      out: "moved ok; checked 2 json files\n",
    });
  };
  const d = deps({ wslDistros: () => Promise.resolve(["Ubuntu"]), wslRun });
  const r = await run(opts(t.parent), d);
  const text = r.lines.join("\n");
  assertEquals(r.code, 0, text);
  const fresh = pathOf(t.parent, "AIB");
  const backup = pathOf(t.parent, "AgentStudio.old-2026-11-24");
  const copied = treeStats(fresh); // the script compared size right after the copy; rewriting the shorter name then makes files smaller
  assertEquals([copied.files, copied.dirs, copied.links], [
    before.files,
    before.dirs,
    before.links,
  ], "file count matches");
  assert(copied.bytes < before.bytes, "rewritten paths are shorter");
  assert(text.includes("copied and verified"), text);
  assert(!exists(old) && exists(backup), "old folder renamed, not deleted");
  assertEquals(treeStats(backup), before);
  assert(text.includes("To undo") && text.includes("--undo"), text);
  // state files point at the new folder, others are untouched
  const chat = JSON.parse(
    Deno.readTextFileSync(pathOf(fresh, "chats", "c1.json")),
  );
  assertEquals(chat.cwd, pathOf(fresh, "worktrees", "h1", "wt1"));
  assertEquals(
    chat.other,
    pathOf(t.parent, "AgentStudio.keep"),
    "a longer name is not the folder",
  );
  assertEquals(chat.fwd, fresh.replaceAll("\\", "/") + "/x");
  assert(
    Deno.readTextFileSync(pathOf(fresh, "keeper", "journal.jsonl")).includes(
      "AgentStudio",
    ),
    "keeper files are never rewritten",
  );
  assert(
    Deno.readTextFileSync(pathOf(fresh, "agents", "codex", "a.json")).includes(
      "AgentStudio",
    ),
    "agent files are never rewritten",
  );
  // the repository points at the worktree in the new folder
  const listed = (await git(repo, "worktree", "list", "--porcelain"))
    .replaceAll("\\", "/").toLowerCase();
  assert(
    listed.includes(
      (fresh + "/worktrees/h1/wt1").replaceAll("\\", "/").toLowerCase(),
    ),
    listed,
  );
  assert(!listed.includes("/agentstudio/"), listed);
  // WSL: check then move, for the hashes of the old and the new Windows folder
  assertEquals(asked.length, 2);
  assertEquals(asked[0].args.slice(1), [dataDirName(old), dataDirName(fresh)]);
  assertEquals(asked[1].args.slice(1, 3), [
    dataDirName(old),
    dataDirName(fresh),
  ]);
  assert(
    asked[1].args.length > 3,
    "the move also rewrites the Windows path in the distro files",
  );

  // undo
  asked.length = 0;
  const u = await run(opts(t.parent, { undo: true }), d);
  const utext = u.lines.join("\n");
  assertEquals(u.code, 0, utext);
  assertEquals(treeStats(old), before, "the old folder is back, unchanged");
  assert(
    !exists(fresh) && !exists(backup),
    "the new folder is set aside, the backup name is gone",
  );
  const aside = [...Deno.readDirSync(t.parent)].map((e) => e.name).filter((n) =>
    n.startsWith("AIB.undone-")
  );
  assertEquals(aside.length, 1, utext);
  assertEquals(asked[1].args.slice(1, 3), [
    dataDirName(fresh),
    dataDirName(old),
  ], "the distro folder goes back too");
  const listed2 = (await git(repo, "worktree", "list", "--porcelain"))
    .replaceAll("\\", "/").toLowerCase();
  assert(listed2.includes("/agentstudio/worktrees/h1/wt1"), listed2);
});

Deno.test("WSL: a process running from the distro data folder refuses; a distro without the folder is skipped with a line", async () => {
  using t = temp();
  const { old } = await fakeData(t.parent, false);
  const wslRun: WslRun = (distro) =>
    Promise.resolve(
      distro === "Busy"
        ? { code: 0, out: "have\nproc 777 /x/AIB-keeper --data /x/data-abc\n" }
        : { code: 0, out: "none\n" },
    );
  const r = await run(
    opts(t.parent),
    deps({ wslDistros: () => Promise.resolve(["Empty", "Busy"]), wslRun }),
  );
  const text = r.lines.join("\n");
  assertEquals(r.code, 1, text);
  assert(text.includes("777") && text.includes("WSL Busy"), text);
  assert(
    text.includes("WSL Empty: no data-") && text.includes("nothing to rename"),
    text,
  );
  assert(exists(old) && !exists(pathOf(t.parent, "AIB")), "nothing changed");
  // no WSL on this PC: says it does not need to
  const r2 = await run(opts(t.parent, { dryRun: true }), deps());
  assert(r2.lines.join("\n").includes("no WSL distros"), r2.lines.join("\n"));
});

Deno.test("rewritePaths: JSON-escaped, plain, forward-slash and /mnt forms; case-insensitive on Windows", () => {
  using t = temp();
  const from = "C:\\Users\\x\\AppData\\Local\\AgentStudio",
    to = "C:\\Users\\x\\AppData\\Local\\AIB";
  const file = pathOf(t.parent, "s.json");
  Deno.writeTextFileSync(
    file,
    JSON.stringify({
      a: from + "\\w",
      b: "C:/Users/x/AppData/Local/AgentStudio/w",
      c: "/mnt/c/Users/x/AppData/Local/AgentStudio/w",
      d: from + ".old",
    }),
  );
  const changed = rewritePaths(t.parent, from, to);
  assertEquals(changed.length, 1);
  const got = JSON.parse(Deno.readTextFileSync(file));
  assertEquals(got.a, to + "\\w");
  assertEquals(got.b, "C:/Users/x/AppData/Local/AIB/w");
  assertEquals(got.c, "/mnt/c/Users/x/AppData/Local/AIB/w");
  assertEquals(got.d, from + ".old");
  void SEP;
});

Deno.test("nothing to do when the old folder is already gone or never existed", async () => {
  using t = temp();
  const r = await run(opts(t.parent), deps());
  assertEquals(r.code, 0);
  assert(r.lines.join("\n").includes("Nothing to do"));
});
