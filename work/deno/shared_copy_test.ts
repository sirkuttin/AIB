/**
 * aib-shared/ is a LINK to the main folder's one in every worktree, for every provider (never a copy, not for Claude either): a 5,000-file
 * shared folder costs nothing at the start of a builder (it was copied whole by a 0.16 beta, which broke every Agent call in a project
 * with 4.7 GB in it), and the folder AIB's old copy feature left (a real folder with a seed note) is retired, never a link's target.
 */
import { assert, assertEquals } from "./_assert.ts";
import { linkShared, unlinkShared } from "../../app/server/worktrees/shared_link.ts";
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
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lab() {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "aib-sc-" }));
  const main = p(dir, "main"), wtree = p(dir, "wt");
  Deno.mkdirSync(p(main, "aib-shared", "old"), { recursive: true });
  Deno.mkdirSync(wtree);
  Deno.writeTextFileSync(p(main, "aib-shared", "keep.txt"), "keep\n");
  const lo = { project: main, excludeFile: "", prefix: "", entries: ["aib-shared"], existing: [], defaultState: "on" } as unknown as LocalOnly;
  return { dir, main, wtree, lo, shared: p(main, "aib-shared"), mine: p(wtree, "aib-shared") };
}

Deno.test("shared link: the worktree's aib-shared is a link; a file written through it is in the main folder at once", () => {
  const l = lab();
  try {
    assertEquals(linkShared(l.wtree, l.lo), "linked");
    assert(Deno.lstatSync(l.mine).isSymlink, "a link, not a copy");
    assertEquals(read(p(l.mine, "keep.txt")), "keep\n");
    Deno.writeTextFileSync(p(l.mine, "new.md"), "written through the link\n");
    assertEquals(read(p(l.shared, "new.md")), "written through the link\n");
    assertEquals(unlinkShared(l.wtree), true);
    assertEquals(read(p(l.shared, "new.md")), "written through the link\n", "removing the link leaves the main folder's files");
  } finally {
    Deno.removeSync(l.dir, { recursive: true });
  }
});

Deno.test("shared link: a 5,000-file main aib-shared/ costs nothing at the start of a builder", () => {
  const l = lab();
  try {
    const big = p(l.shared, "review");
    Deno.mkdirSync(big);
    for (let i = 0; i < 5000; i++) Deno.writeTextFileSync(p(big, `f${i}.txt`), "x\n");
    const started = performance.now();
    assertEquals(linkShared(l.wtree, l.lo), "linked");
    assert(performance.now() - started < 500, "making the link touches no file");
    assert(Deno.lstatSync(l.mine).isSymlink);
    assertEquals(read(p(l.mine, "review", "f4999.txt")), "x\n");
  } finally {
    Deno.removeSync(l.dir, { recursive: true });
  }
});

Deno.test("shared link: an old build's seeded copy (a real folder with .aib-seed.json) is retired with the worktree or replaced by the link; other real folders are never touched", async () => {
  const l = lab();
  try {
    const old = (files: Record<string, string>) => {
      Deno.mkdirSync(l.mine, { recursive: true });
      for (const [n, c] of Object.entries(files)) Deno.writeTextFileSync(p(l.mine, n), c);
    };
    // retired with its worktree
    old({ "keep.txt": "keep\n", ".aib-seed.json": "{}" });
    assertEquals(unlinkShared(l.wtree), true);
    for (let i = 0; i < 50 && Deno.statSync(l.wtree) && [...Deno.readDirSync(l.wtree)].length; i++) await delay(100);
    assertEquals([...Deno.readDirSync(l.wtree)].length, 0, "the seeded copy is gone from the worktree");
    assertEquals(read(p(l.shared, "keep.txt")), "keep\n", "the main folder is untouched");
    // replaced by the link when the worktree is reused
    old({ "x.txt": "x\n", ".aib-seed.json": "{}" });
    assertEquals(linkShared(l.wtree, l.lo), "linked");
    assert(Deno.lstatSync(l.mine).isSymlink);
    assertEquals(read(p(l.mine, "x.txt")), null);
    // a real folder with files and no note is the worktree's own: left alone
    Deno.removeSync(l.mine);
    old({ "mine.txt": "mine\n" });
    assertEquals(unlinkShared(l.wtree), true);
    assertEquals(read(p(l.mine, "mine.txt")), "mine\n");
    assertEquals(linkShared(l.wtree, l.lo), "blocked");
  } finally {
    await delay(200);
    Deno.removeSync(l.dir, { recursive: true });
  }
});
