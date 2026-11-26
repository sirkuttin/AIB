/**
 * The project's shared folder, `aib-shared/` (Deno only; owner decision 2026-11-17). It lives ONLY in the project's main folder; every
 * chat, helper and subagent reads and writes that one folder, also from its own worktree: each worktree AIB makes gets a link named
 * `aib-shared` at the project's place in it, pointing at the main folder's real `aib-shared`:
 *   Windows        a directory junction (no admin rights needed)
 *   WSL / Linux    a symbolic link (made in the distro by its helper, which runs this same module)
 * No copies, no sync: a file written through the link is in the main folder at once. The common .git/info/exclude holds `/aib-shared`
 * in AIB's block (local_only.ts ensureDefault), and the line has no trailing slash, so git ignores the link (a symlink is a file to
 * git) and the junction (a folder to Git for Windows) in every worktree and branch alike.
 *
 * The link is made only while that line is in force (local_only.ts DefaultState 'on'): a project that commits `aib-shared/`, or
 * whose .gitignore turns it back on, gets no link, as it would be committed.
 *
 * Removal: `git worktree remove` and a recursive delete FOLLOW a junction on Windows and empty the real folder. Every removal of a
 * worktree AIB made calls unlinkShared first (the link only, never what it points at) and stops when the link stays.
 */
import * as osp from "../platform/ospath.ts";
import { DEFAULT_ENTRY, type LocalOnly, localOnlyOf } from "./local_only.ts";

/** The folder's name (the default local-only entry). */
export const SHARED_DIR = DEFAULT_ENTRY;

export type LinkOutcome = "linked" | "kept" | "off" | "blocked";

function lstat(path: string): Deno.FileInfo | null {
  try {
    return Deno.lstatSync(path);
  } catch {
    return null;
  }
}

const strip = (p: string) => (p.startsWith("\\\\?\\") ? p.slice(4) : p);
const key = (p: string) =>
  osp.normcase(osp.normpath(strip(p))).replace(/[\\/]+$/, "");

/** Where a worktree's link goes: the project's place in the checkout (`prefix`, '' or 'sub/dir/'), then `aib-shared`. */
export function sharedLinkPath(worktree: string, prefix = ""): string {
  const parts = prefix.split("/").filter(Boolean);
  return osp.join(worktree, ...parts, SHARED_DIR);
}

/** The main folder's real shared folder, '' when the project has none in force (not git, tracked, negated or removed by the user). */
export function sharedDirOf(lo: LocalOnly | null): string {
  if (!lo || lo.defaultState !== "on") return "";
  const entry = lo.entries.find((e) => e.toLowerCase() === SHARED_DIR) ??
    SHARED_DIR;
  return osp.join(lo.project, ...entry.split("/"));
}

/** True when `link` is a link (junction or symlink) whose target is `target`. */
export function linksTo(link: string, target: string): boolean {
  const st = lstat(link);
  if (!st?.isSymlink) return false;
  try {
    let to = Deno.readLinkSync(link);
    if (!osp.isabs(to)) to = osp.join(osp.dirname(link), to);
    return key(to) === key(target);
  } catch {
    return false;
  }
}

/** Test hooks: `make` replaces the link call; `unlink` runs before a link is removed (throwing makes it stay: a locked junction). */
export const _linkHooks: {
  make: null | ((target: string, link: string) => void);
  unlink: null | ((link: string) => void);
} = {
  make: null,
  unlink: null,
};

function makeLink(target: string, link: string): void {
  if (_linkHooks.make) return _linkHooks.make(target, link);
  // a junction needs no admin rights or developer mode; its target must be absolute (it is: the main folder's path)
  Deno.symlinkSync(target, link, osp.WIN ? { type: "junction" } : undefined);
}

/**
 * Gives the worktree at `worktree` (its checkout root) its `aib-shared` link to the main folder's real one, made (empty) first when
 * missing. Idempotent: a correct link is kept, a wrong or broken link is replaced, an empty real folder (an agent's mkdir before the
 * link existed) is replaced. A non-empty real folder is never deleted: 'blocked' (and logged by the caller). Never throws.
 */
export function linkShared(
  worktree: string,
  lo: LocalOnly | null,
  warn: (text: string) => void = () => {},
): LinkOutcome {
  const target = sharedDirOf(lo);
  if (!target || !lo) return "off";
  const link = sharedLinkPath(worktree, lo.prefix);
  try {
    if (key(link) === key(target)) return "off"; // the main folder itself (never a worktree of its own)
    Deno.mkdirSync(target, { recursive: true });
    if (linksTo(link, target)) return "kept";
    const st = lstat(link);
    if (st?.isSymlink) Deno.removeSync(link); // a link elsewhere (an old main folder) or a broken one: the link only
    else if (st?.isDirectory) {
      if ([...Deno.readDirSync(link)].length) {
        warn(
          `${link} is a folder with files, not a link to ${target}: left as it is`,
        );
        return "blocked";
      }
      Deno.removeSync(link);
    } else if (st) {
      warn(`${link} is a file, not a link to ${target}: left as it is`);
      return "blocked";
    }
    Deno.mkdirSync(osp.dirname(link), { recursive: true });
    makeLink(target, link);
    return "linked";
  } catch (error) {
    warn(
      `Could not link ${link} to ${target}: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return "blocked";
  }
}

/** linkShared for a worktree of `project` (its local-only lookup is read first). Never throws. */
export async function linkSharedFor(
  worktree: string,
  project: string,
  warn: (text: string) => void = () => {},
): Promise<LinkOutcome> {
  let lo: LocalOnly | null = null;
  try {
    lo = await localOnlyOf(project);
  } catch { /* not readable: no link */ }
  return linkShared(worktree, lo, warn);
}

/**
 * Before a worktree is removed: takes its `aib-shared` link away (the link only). `prefixes`: the project's place in the checkout
 * when known (the root is always checked). True when no link is left at those places; false when one could not be removed (the
 * caller must not delete the tree then). A real folder of that name is left alone (it belongs to the worktree).
 */
export function unlinkShared(
  worktree: string,
  prefixes: string[] = [],
): boolean {
  let ok = true;
  const seen = new Set<string>();
  for (const prefix of ["", ...prefixes]) {
    const link = sharedLinkPath(worktree, prefix);
    if (seen.has(key(link))) continue;
    seen.add(key(link));
    if (!lstat(link)?.isSymlink) continue;
    try {
      _linkHooks.unlink?.(link);
      Deno.removeSync(link); // non-recursive: a junction or symlink itself, never its target's files
    } catch { /* checked below */ }
    if (lstat(link)) ok = false;
  }
  return ok;
}

/** unlinkShared for a worktree of `project`: the project's prefix is read from git when it can be. */
export async function unlinkSharedFor(
  worktree: string,
  project: string,
): Promise<boolean> {
  let prefix = "";
  try {
    prefix = (await localOnlyOf(project))?.prefix ?? "";
  } catch { /* the root is still checked */ }
  return unlinkShared(worktree, prefix ? [prefix] : []);
}

// ---- a real folder instead of the link, for Claude Code's subagent worktrees ------------------------------------------------
/*
 * Claude Code's worktree isolation refuses every Write/Edit whose real path is in the main folder, and it does so BEFORE any hook runs
 * (work/deno/e2e_subagent_shared_test.ts: a PreToolUse hook is never asked, so neither `allow` nor `updatedInput` can help). The link
 * to the main folder's aib-shared/ therefore cannot be written through. A Claude builder's worktree gets a REAL `aib-shared/` instead:
 * a copy of the main one when the worktree is made, and what the builder added or changed in it is copied back into the main
 * folder's aib-shared/ when the builder ends and again before the worktree is removed (never committed: it stays git-ignored).
 * Merge rule: new files, and files the builder changed since the copy, win; nothing is ever deleted in the main folder; a file the
 * builder left as the copy had it never overwrites a newer one in the main folder. Links and special files are never copied either way.
 */
/** The note of what the copy looked like (path -> [size, mtime ms]); kept in the copy's own folder, never copied back. */
export const SEED_FILE = ".aib-seed.json";
const SEED_MAX_BYTES = 20 * 1024 * 1024;

type Seed = Record<string, [number, number]>;

/** Regular files below `dir` as [relative path with '/', size, mtime ms]; links, special files and the seed note are skipped. */
function filesUnder(dir: string, prefix = ""): [string, number, number][] {
  const out: [string, number, number][] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = osp.join(dir, e.name);
    const st = lstat(full);
    if (!st || st.isSymlink) continue;
    if (st.isDirectory) out.push(...filesUnder(full, rel));
    else if (st.isFile && rel !== SEED_FILE) {
      out.push([rel, st.size, st.mtime?.getTime() ?? 0]);
    }
  }
  return out;
}

function copyFileKeepTime(from: string, to: string): void {
  Deno.mkdirSync(osp.dirname(to), { recursive: true });
  Deno.copyFileSync(from, to);
  const st = lstat(from);
  if (st?.mtime) Deno.utimeSync(to, new Date(), st.mtime);
}

function readSeed(dir: string): Seed | null {
  try {
    return JSON.parse(Deno.readTextFileSync(osp.join(dir, SEED_FILE))) as Seed;
  } catch {
    return null;
  }
}

const safeRel = (rel: string) =>
  !!rel &&
  !rel.split("/").some((p) =>
    !p || p === "." || p === ".." || /[:\\\0]/.test(p)
  );

/**
 * Gives the Claude subagent worktree its own REAL `aib-shared/`: a copy of the main folder's (files over 20 MB and links are left
 * out). Replaces a link, or a copy made earlier by this function (a spare worktree being reused, never written to yet). A real
 * folder with files but no seed note is never touched ('blocked'). Never throws.
 */
export function copySharedIn(
  worktree: string,
  lo: LocalOnly | null,
  warn: (text: string) => void = () => {},
): LinkOutcome {
  const target = sharedDirOf(lo);
  if (!target || !lo) return "off";
  const dest = sharedLinkPath(worktree, lo.prefix);
  try {
    if (key(dest) === key(target)) return "off";
    Deno.mkdirSync(target, { recursive: true });
    const st = lstat(dest);
    if (st?.isSymlink) Deno.removeSync(dest); // the link only
    else if (st?.isDirectory) {
      if (readSeed(dest) || ![...Deno.readDirSync(dest)].length) {
        Deno.removeSync(dest, { recursive: true });
      } else {
        warn(`${dest} is a folder with files and no seed note: left as it is`);
        return "blocked";
      }
    } else if (st) {
      warn(`${dest} is a file, not a folder: left as it is`);
      return "blocked";
    }
    Deno.mkdirSync(dest, { recursive: true });
    const seed: Seed = {};
    for (const [rel, size] of filesUnder(target)) {
      if (size > SEED_MAX_BYTES || !safeRel(rel)) continue;
      const to = osp.join(dest, ...rel.split("/"));
      copyFileKeepTime(osp.join(target, ...rel.split("/")), to);
      const got = lstat(to);
      if (got) seed[rel] = [got.size, got.mtime?.getTime() ?? 0];
    }
    Deno.writeTextFileSync(osp.join(dest, SEED_FILE), JSON.stringify(seed));
    return "linked";
  } catch (error) {
    warn(
      `Could not copy ${target} into ${dest}: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return "blocked";
  }
}

/** True when no part of `path` below `base` is a link (so a copy there cannot leave the main folder). */
function plainBelow(base: string, path: string): boolean {
  const rel = path.slice(base.length).split(/[\\/]/).filter(Boolean);
  let here = base;
  for (const part of rel) {
    here = osp.join(here, part);
    const st = lstat(here);
    if (!st) return true;
    if (st.isSymlink) return false;
  }
  return true;
}

/**
 * Copies what the builder added or changed in the worktree's real `aib-shared/` into the main folder's. Returns the relative paths
 * copied. Safe to repeat (the seed note is brought up to date). A link there (not a copy) has nothing to copy. Never throws.
 */
export function syncSharedBack(
  worktree: string,
  lo: LocalOnly | null,
  warn: (text: string) => void = () => {},
): string[] {
  const done: string[] = [];
  const target = sharedDirOf(lo);
  if (!target || !lo) return done;
  const src = sharedLinkPath(worktree, lo.prefix);
  try {
    const st = lstat(src);
    if (!st?.isDirectory) return done;
    const seed = readSeed(src);
    if (!seed) return done; // not a copy AIB made
    const next: Seed = {};
    for (const [rel, size, mtime] of filesUnder(src)) {
      next[rel] = [size, mtime];
      const was = seed[rel];
      if (was && was[0] === size && was[1] === mtime) continue; // as the copy had it
      if (!safeRel(rel)) continue;
      const to = osp.join(target, ...rel.split("/"));
      const there = lstat(to);
      if (there && !there.isFile) continue; // never replace a folder or a link of the main folder
      if (!plainBelow(target, to)) continue;
      copyFileKeepTime(osp.join(src, ...rel.split("/")), to);
      done.push(rel);
    }
    Deno.writeTextFileSync(osp.join(src, SEED_FILE), JSON.stringify(next));
  } catch (error) {
    warn(
      `Could not copy ${src} back into ${target}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  return done;
}

/** syncSharedBack for a worktree of `project` (its local-only lookup is read first). Never throws. */
export async function syncSharedBackFor(
  worktree: string,
  project: string,
  warn: (text: string) => void = () => {},
): Promise<string[]> {
  let lo: LocalOnly | null = null;
  try {
    lo = await localOnlyOf(project);
  } catch { /* not readable: nothing to copy */ }
  return syncSharedBack(worktree, lo, warn);
}
