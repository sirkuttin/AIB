/**
 * A Claude builder's worktree gets a real copy of the project's aib-shared/ that goes back when it ends (worktrees/shared_link.ts
 * copySharedIn / syncSharedBack). The merge rule: new and changed files win, nothing is deleted in the main folder, a file left as the
 * copy had it never overwrites a newer one there, links are never followed, the seed note is never copied back.
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  copySharedIn,
  SEED_FILE,
  syncSharedBack,
} from "../../app/server/worktrees/shared_link.ts";
import type { LocalOnly } from "../../app/server/worktrees/local_only.ts";

const SEP = Deno.build.os === "windows" ? "\\" : "/";
const p = (...parts: string[]) => parts.join(SEP);
const read = (path: string): string | null => {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
};

function lab() {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "aib-sc-" }));
  const main = p(dir, "main"), wtree = p(dir, "wt");
  Deno.mkdirSync(p(main, "aib-shared", "old"), { recursive: true });
  Deno.mkdirSync(wtree);
  Deno.writeTextFileSync(p(main, "aib-shared", "keep.txt"), "keep\n");
  Deno.writeTextFileSync(p(main, "aib-shared", "edit.txt"), "v1\n");
  Deno.writeTextFileSync(p(main, "aib-shared", "old", "a.txt"), "a\n");
  const lo = {
    project: main,
    excludeFile: "",
    prefix: "",
    entries: ["aib-shared"],
    existing: [],
    defaultState: "on",
  } as unknown as LocalOnly;
  return {
    dir,
    main,
    wtree,
    lo,
    shared: p(main, "aib-shared"),
    mine: p(wtree, "aib-shared"),
  };
}

Deno.test("shared copy: the worktree gets a real folder with the main one's files; a sync copies new and changed files only", () => {
  const l = lab();
  try {
    assertEquals(copySharedIn(l.wtree, l.lo), "linked");
    assert(!Deno.lstatSync(l.mine).isSymlink);
    assertEquals(read(p(l.mine, "old", "a.txt")), "a\n");
    assert(read(p(l.mine, SEED_FILE)) !== null);
    assertEquals(
      syncSharedBack(l.wtree, l.lo),
      [],
      "nothing changed: nothing copied",
    );
    // the main folder moves on while the builder works
    Deno.writeTextFileSync(p(l.shared, "keep.txt"), "newer in main\n");
    Deno.writeTextFileSync(p(l.shared, "other.txt"), "by another agent\n");
    // the builder adds, changes and deletes
    Deno.writeTextFileSync(p(l.mine, "edit.txt"), "v2 by builder\n");
    Deno.mkdirSync(p(l.mine, "design"));
    Deno.writeTextFileSync(p(l.mine, "design", "new.md"), "report\n");
    Deno.removeSync(p(l.mine, "old", "a.txt"));
    assertEquals(syncSharedBack(l.wtree, l.lo).sort(), [
      "design/new.md",
      "edit.txt",
    ]);
    assertEquals(
      read(p(l.shared, "edit.txt")),
      "v2 by builder\n",
      "a changed file wins",
    );
    assertEquals(read(p(l.shared, "design", "new.md")), "report\n");
    assertEquals(
      read(p(l.shared, "keep.txt")),
      "newer in main\n",
      "a file left as the copy had it never overwrites a newer one",
    );
    assertEquals(read(p(l.shared, "other.txt")), "by another agent\n");
    assertEquals(
      read(p(l.shared, "old", "a.txt")),
      "a\n",
      "nothing is deleted in the main folder",
    );
    assertEquals(
      read(p(l.shared, SEED_FILE)),
      null,
      "the seed note stays in the copy",
    );
    assertEquals(
      syncSharedBack(l.wtree, l.lo),
      [],
      "repeating copies nothing more",
    );
    // a second change after the first sync (a continued builder) goes too
    Deno.writeTextFileSync(p(l.mine, "design", "new.md"), "report 2\n");
    assertEquals(syncSharedBack(l.wtree, l.lo), ["design/new.md"]);
    assertEquals(read(p(l.shared, "design", "new.md")), "report 2\n");
  } finally {
    Deno.removeSync(l.dir, { recursive: true });
  }
});

Deno.test("shared copy: a link in the copy is never followed, and a link in the main folder is never written through", () => {
  const l = lab();
  try {
    const outside = p(l.dir, "outside");
    Deno.mkdirSync(outside);
    copySharedIn(l.wtree, l.lo);
    try {
      Deno.symlinkSync(
        outside,
        p(l.mine, "leak"),
        Deno.build.os === "windows" ? { type: "junction" } : undefined,
      );
      Deno.symlinkSync(
        outside,
        p(l.shared, "trap"),
        Deno.build.os === "windows" ? { type: "junction" } : undefined,
      );
    } catch {
      return; // no link rights here: nothing to check
    }
    Deno.writeTextFileSync(p(outside, "secret.txt"), "secret\n");
    Deno.mkdirSync(p(l.mine, "trap"));
    Deno.writeTextFileSync(p(l.mine, "trap", "x.txt"), "x\n");
    assertEquals(syncSharedBack(l.wtree, l.lo), []);
    assertEquals(read(p(l.shared, "leak", "secret.txt")), null);
    assertEquals(
      read(p(outside, "x.txt")),
      null,
      "nothing written through a link of the main folder",
    );
  } finally {
    Deno.removeSync(l.dir, { recursive: true });
  }
});

Deno.test("shared copy: a real folder with files and no seed note is left alone; a link or an old copy is replaced", () => {
  const l = lab();
  try {
    Deno.mkdirSync(l.mine);
    Deno.writeTextFileSync(p(l.mine, "mine.txt"), "x\n");
    assertEquals(copySharedIn(l.wtree, l.lo), "blocked");
    assertEquals(read(p(l.mine, "mine.txt")), "x\n");
    assertEquals(
      syncSharedBack(l.wtree, l.lo),
      [],
      "no seed note: not a copy AIB made",
    );
    Deno.removeSync(l.mine, { recursive: true });
    assertEquals(copySharedIn(l.wtree, l.lo), "linked");
    assertEquals(
      copySharedIn(l.wtree, l.lo),
      "linked",
      "a copy made earlier is made again",
    );
    assertEquals(read(p(l.mine, "keep.txt")), "keep\n");
  } finally {
    Deno.removeSync(l.dir, { recursive: true });
  }
});
