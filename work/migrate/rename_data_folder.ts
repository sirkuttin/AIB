/**
 * One-time script (owner decision 2026-11-24, "3b"): AIB's data folder gets the new name `AIB`.
 *   Windows  %LOCALAPPDATA%\AgentStudio                -> %LOCALAPPDATA%\AIB
 *   macOS    ~/Library/Application Support/AgentStudio -> ~/Library/Application Support/AIB
 *   Linux    $XDG_STATE_HOME/agent-studio              -> $XDG_STATE_HOME/aib   (default ~/.local/state/...)
 * The app never does this itself (owner rule: one-time migrations are scripts he runs). Until you run it, AIB keeps using the old
 * folder as it is; once the new folder exists AIB uses only that one.
 *
 * HOW TO RUN IT (once on each PC; Windows, macOS or Linux):
 *   1. Quit AIB (its window, and the tray icon), then wait a few seconds. Chats keep running in the keeper only while it runs, so
 *      the keeper has to be stopped too: the script lists anything still using the folder, by name and PID, and stops there.
 *   2. From the repo folder (C:\Users\sirku\Documents\Codex\AIB), look at the plan first:
 *        deno run -A work/migrate/rename_data_folder.ts --dry-run
 *   3. Do it:
 *        deno run -A work/migrate/rename_data_folder.ts
 *   4. Start AIB. It opens the new folder. Keep AgentStudio.old-<date> next to it for a while; delete it by hand when you are happy.
 *   Undo (puts the old folder back, sets the new one aside as AIB.undone-<time>; anything done in AIB since is in that folder):
 *        deno run -A work/migrate/rename_data_folder.ts --undo
 *
 * What it does, in order (it prints each step and what it did):
 *   - refuses while AIB, its keeper, or any process that runs from or names the folder is alive (name and PID are shown; it never
 *     kills anything). Also refuses when the new folder already exists, or when the old folder is held open (rename probe).
 *   - copies the old folder to the new name (robocopy on Windows, cp -a elsewhere; the new folder is owner-only like AIB makes it),
 *     then checks file count and total size against the original.
 *   - rewrites the old folder path inside AIB's small state files in the copy (*.json, *.jsonl, *.toml; not worktrees/, agents/,
 *     keeper/, keeper-bin/, scratch/), so chats and worktree records point at the new location.
 *   - runs `git worktree repair` for every AIB worktree in the copy so each repository points at the new worktree folder.
 *   - renames the old folder to AgentStudio.old-<date> (never deletes it).
 *   - Windows: for each WSL distro, the helper keeps its data in ~/.aib-server/data-<hash of the Windows data folder path>. The hash
 *     changes with the name, so the script renames that folder to the new hash too (and rewrites the Windows path inside its json
 *     files). Distros without such a folder, and non-Windows PCs, are skipped with a line saying so. It refuses while an AIB process
 *     runs from that data folder in the distro.
 *
 * Options: --dry-run (print the plan, change nothing), --undo, --no-wsl (leave the distros alone), --parent <folder> (the folder that
 * holds the old and new names; default %LOCALAPPDATA% / the XDG state folder; tests use it), --wsl-root <linux path> (tests).
 * Exit code 0 = done (or plan printed), 1 = refused or failed (nothing changed unless the output says so).
 */
import { dataDirName } from "../../app/server/wsl/install.ts";
import {
  makeOwnerOnly,
  pathOf,
  userStateDirNames,
} from "../../app/server/state/paths.ts";

const WIN = Deno.build.os === "windows";
const SEP = WIN ? "\\" : "/";
const DEC = new TextDecoder();

export interface ProcInfo {
  pid: number;
  name: string;
  exe: string;
  cmd: string;
  cwd: string;
}
export type ProcLister = () => Promise<ProcInfo[]>;
/** Runs a /bin/sh script inside a WSL distro: (distro, script, args) -> exit code and stdout. */
export type WslRun = (
  distro: string,
  script: string,
  args: string[],
) => Promise<{ code: number; out: string }>;

export interface Opts {
  /** The folder that holds the old and the new data folder. */
  parent: string;
  /** Folder names (new, old). */
  current: string;
  legacy: string;
  dryRun: boolean;
  undo: boolean;
  wsl: boolean;
  /** WSL root override ('' = $HOME/.aib-server inside each distro). */
  wslRoot: string;
}
export interface Deps {
  list: ProcLister;
  /** null: this PC has no WSL (skipped with a line). */
  wslDistros: (() => Promise<string[]>) | null;
  wslRun: WslRun | null;
  now: () => Date;
  /** Also refuse for AIB / keeper programs by name (default true; tests turn it off so the owner's real AIB never matters). */
  checkNames: boolean;
}
export interface Result {
  code: number;
  lines: string[];
}

// ---- processes ---------------------------------------------------------------------------------------------------------------------
const NAMES = /^(AIB|AIB-keeper|AIB-wsl-helper)(\.exe)?$/i;

const norm = (p: string) => p.replaceAll("/", "\\").toLowerCase();

/** Why this process holds the folder ('' = it does not). */
export function holds(
  p: ProcInfo,
  folder: string,
  checkNames: boolean,
): string {
  const f = norm(folder).replace(/\\+$/, "");
  const inside = (text: string) => {
    const t = norm(text);
    return t === f || t.includes(f + "\\") || t.includes(f + '"') ||
      t.endsWith(f) || t.includes(f + " ");
  };
  if (p.exe && inside(p.exe)) return "runs a program from the folder";
  if (p.cwd && inside(p.cwd)) return "works inside the folder";
  if (p.cmd && inside(p.cmd)) return "has the folder in its command line";
  if (checkNames && NAMES.test(p.name)) return "is AIB or its keeper";
  return "";
}

export function findHolders(
  procs: ProcInfo[],
  folder: string,
  checkNames: boolean,
  ignore: number[],
): { p: ProcInfo; why: string }[] {
  const out: { p: ProcInfo; why: string }[] = [];
  for (const p of procs) {
    if (ignore.includes(p.pid)) continue;
    const why = holds(p, folder, checkNames);
    if (why) out.push({ p, why });
  }
  return out;
}

export const realLister: ProcLister = async () => {
  const procs: ProcInfo[] = [];
  if (WIN) {
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $_.ExecutablePath, ($_.CommandLine -replace '[\\r\\n]+',' ') }";
    const r = await new Deno.Command("powershell.exe", {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      stdout: "piped",
      stderr: "piped",
    })
      .output();
    if (!r.success) {
      throw new Error(
        "Could not list the running processes: " + DEC.decode(r.stderr).trim(),
      );
    }
    for (const line of DEC.decode(r.stdout).split(/\r?\n/)) {
      const m = /^(\d+)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line);
      if (m) {
        procs.push({
          pid: Number(m[1]),
          name: m[2],
          exe: m[3],
          cmd: m[4],
          cwd: "",
        });
      }
    }
    return procs;
  }
  const r = await new Deno.Command("ps", {
    args: ["-eo", "pid=,comm=,args="],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) {
    throw new Error(
      "Could not list the running processes: " + DEC.decode(r.stderr).trim(),
    );
  }
  for (const line of DEC.decode(r.stdout).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    let cwd = "", exe = "";
    try {
      cwd = Deno.readLinkSync(`/proc/${pid}/cwd`);
      exe = Deno.readLinkSync(`/proc/${pid}/exe`);
    } catch { /* not Linux, or not ours to read */ }
    procs.push({ pid, name: m[2].replace(/^.*\//, ""), exe, cmd: m[3], cwd });
  }
  return procs;
};

// ---- files -------------------------------------------------------------------------------------------------------------------------
const lstat = (p: string): Deno.FileInfo | null => {
  try {
    return Deno.lstatSync(p);
  } catch {
    return null;
  }
};
const isDir = (p: string) => lstat(p)?.isDirectory === true;

export interface Stats {
  files: number;
  bytes: number;
  dirs: number;
  links: number;
}
/** File count and total size of a tree, links counted as links (never followed). */
export function treeStats(root: string): Stats {
  const s: Stats = { files: 0, bytes: 0, dirs: 0, links: 0 };
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(dir)) {
      const p = dir + SEP + e.name;
      const info = Deno.lstatSync(p);
      if (info.isSymlink) s.links++;
      else if (info.isDirectory) {
        s.dirs++;
        walk(p);
      } else {
        s.files++;
        s.bytes += info.size;
      }
    }
  };
  walk(root);
  return s;
}

const fmtBytes = (
  n: number,
) => (n >= 1 << 30
  ? (n / (1 << 30)).toFixed(2) + " GB"
  : (n / (1 << 20)).toFixed(1) + " MB");
const fmtStats = (s: Stats) =>
  `${s.files} files, ${s.dirs} folders, ${s.links} links, ${
    fmtBytes(s.bytes)
  } (${s.bytes} bytes)`;

async function copyTree(from: string, to: string): Promise<void> {
  if (WIN) {
    const r = await new Deno.Command("robocopy", {
      args: [
        from,
        to,
        "/E",
        "/COPY:DAT",
        "/DCOPY:DAT",
        "/SJ",
        "/SL",
        "/R:1",
        "/W:1",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP",
        "/MT:8",
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    if (r.code >= 8) throw new Error(`robocopy failed (exit code ${r.code})`);
  } else {
    const r = await new Deno.Command("cp", {
      args: ["-a", from + "/.", to + "/"],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!r.success) {
      throw new Error("cp failed: " + DEC.decode(r.stderr).trim());
    }
  }
}

const TEXT_EXT = /\.(json|jsonl|toml)$/i;
const SKIP_TOP = new Set([
  "worktrees",
  "agents",
  "keeper",
  "keeper-bin",
  "scratch",
  "updates",
  "logs",
]);
const MAX_TEXT = 64 << 20;

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ways the old folder path is written in state files: JSON-escaped, plain, forward slashes, /mnt/<drive>/ (WSL). */
export function pathForms(from: string, to: string): [string, string][] {
  const forms: [string, string][] = [];
  const add = (a: string, b: string) => {
    if (!forms.some(([x]) => x === a)) forms.push([a, b]);
  };
  const dbl = (p: string) => p.replaceAll("\\", "\\\\");
  const fwd = (p: string) => p.replaceAll("\\", "/");
  const mnt = (p: string) => {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll("\\", "/")}` : "";
  };
  if (from.includes("\\")) add(dbl(from), dbl(to));
  add(from, to);
  if (from.includes("\\")) add(fwd(from), fwd(to));
  if (mnt(from)) add(mnt(from), mnt(to));
  return forms;
}

/** Rewrites the old path to the new one in the small state files of `root` (the copy). Returns the files changed. */
export function rewritePaths(root: string, from: string, to: string): string[] {
  const forms = pathForms(from, to).map(([a, b]) =>
    [new RegExp(reEsc(a) + "(?![A-Za-z0-9_.-])", WIN ? "gi" : "g"), b] as const
  );
  const changed: string[] = [];
  const walk = (dir: string, top: boolean) => {
    for (const e of Deno.readDirSync(dir)) {
      const p = dir + SEP + e.name;
      const info = Deno.lstatSync(p);
      if (info.isSymlink) continue;
      if (info.isDirectory) {
        if (!(top && SKIP_TOP.has(e.name.toLowerCase()))) walk(p, false);
      } else if (TEXT_EXT.test(e.name) && info.size <= MAX_TEXT) {
        const text = Deno.readTextFileSync(p);
        let next = text;
        for (const [re, b] of forms) next = next.replace(re, () => b);
        if (next !== text) {
          const tmp = p + ".rename-tmp";
          Deno.writeTextFileSync(tmp, next);
          Deno.renameSync(tmp, p);
          changed.push(p);
        }
      }
    }
  };
  walk(root, true);
  return changed;
}

/** AIB worktrees in a data folder: worktrees/<id>/<name> with a .git file. */
export function worktreeFolders(root: string): string[] {
  const out: string[] = [];
  const base = root + SEP + "worktrees";
  if (!isDir(base)) return out;
  for (const a of Deno.readDirSync(base)) {
    const ap = base + SEP + a.name;
    if (!isDir(ap)) continue;
    for (const b of Deno.readDirSync(ap)) {
      const bp = ap + SEP + b.name;
      if (lstat(bp + SEP + ".git")?.isFile) out.push(bp);
    }
  }
  return out;
}

async function repairWorktrees(root: string, lines: string[]): Promise<void> {
  const wts = worktreeFolders(root);
  if (!wts.length) {
    lines.push("  no AIB worktrees in the folder: nothing to repair");
    return;
  }
  let ok = 0;
  for (const wt of wts) {
    try {
      const r = await new Deno.Command("git", {
        args: ["-C", wt, "worktree", "repair", wt],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (r.success) ok++;
      else {lines.push(
          `  WARNING: git worktree repair failed for ${wt}: ${
            DEC.decode(r.stderr).trim()
          }`,
        );}
    } catch (error) {
      lines.push(
        `  WARNING: could not run git for ${wt}: ${(error as Error).message}`,
      );
    }
  }
  lines.push(
    `  git worktree repair: ${ok} of ${wts.length} worktrees repaired`,
  );
}

// ---- WSL ---------------------------------------------------------------------------------------------------------------------------
const WSL_CHECK = `root="$1"; [ -n "$root" ] || root="$HOME/.aib-server"
[ -d "$root/$2" ] || { echo none; exit 0; }
[ -e "$root/$3" ] && { echo clash; exit 0; }
echo have
ps -eo pid=,args= | grep -F -- "$root/$2" | grep -v -F -e "grep" | while read -r pid args; do [ "$pid" = "$$" ] || echo "proc $pid $args"; done
exit 0
`;
const WSL_MOVE = `root="$1"; [ -n "$root" ] || root="$HOME/.aib-server"
from="$2"; to="$3"; shift 3
mv -- "$root/$from" "$root/$to" || exit 1
n=0
if [ "$#" -gt 0 ]; then
  for f in $(find "$root/$to" -type f \\( -name '*.json' -o -name '*.jsonl' \\) -not -path '*/keeper/*' -not -path '*/worktrees/*' -not -path '*/agents/*'); do
    if sed -i "$@" "$f"; then n=$((n+1)); fi
  done
fi
echo "moved $root/$from -> $root/$to; checked $n json files"
`;

function sedArgs(from: string, to: string): string[] {
  const esc = (s: string) => s.replace(/[\\|.*[\]^$]/g, "\\$&");
  const rep = (s: string) => s.replace(/[\\|&]/g, "\\$&");
  return pathForms(from, to).flatMap((
    [a, b],
  ) => ["-e", `s|${esc(a)}\\([^A-Za-z0-9_.-]\\)|${rep(b)}\\1|Ig`]);
}

async function wslStep(
  opts: Opts,
  deps: Deps,
  fromPath: string,
  toPath: string,
  lines: string[],
): Promise<{ refused: boolean; moves: (() => Promise<void>)[] }> {
  const moves: (() => Promise<void>)[] = [];
  if (!opts.wsl) {
    lines.push("WSL: skipped (--no-wsl).");
    return { refused: false, moves };
  }
  if (!deps.wslDistros || !deps.wslRun) {
    lines.push(
      "WSL: this PC has no WSL distros to look at, so there is no helper data to rename.",
    );
    return { refused: false, moves };
  }
  const distros = await deps.wslDistros();
  if (!distros.length) {
    lines.push("WSL: no distros installed, nothing to rename.");
    return { refused: false, moves };
  }
  const fromName = dataDirName(fromPath), toName = dataDirName(toPath);
  let refused = false;
  for (const d of distros) {
    let res: { code: number; out: string };
    try {
      res = await deps.wslRun(d, WSL_CHECK, [opts.wslRoot, fromName, toName]);
    } catch (error) {
      lines.push(
        `WSL ${d}: could not be read (${(error as Error).message}); skipped.`,
      );
      continue;
    }
    const outLines = res.out.split(/\r?\n/).map((l) => l.trim()).filter(
      Boolean,
    );
    const state = outLines[0] ?? "";
    if (state === "none") {
      lines.push(
        `WSL ${d}: no ${fromName} folder in ~/.aib-server, so nothing to rename (the helper data there does not use this folder name).`,
      );
    } else if (state === "clash") {
      lines.push(
        `WSL ${d}: REFUSED: both ${fromName} and ${toName} exist in ~/.aib-server. Remove the one you do not want, then run again.`,
      );
      refused = true;
    } else if (state === "have") {
      const procs = outLines.filter((l) => l.startsWith("proc "));
      if (procs.length) {
        refused = true;
        lines.push(
          `WSL ${d}: REFUSED: these processes in the distro use ${fromName}. Quit AIB first (Settings > WSL > Remove stops them), or in the distro run \`kill <pid>\`:`,
        );
        for (const l of procs) lines.push("    " + l.slice(5));
      } else {
        lines.push(
          `WSL ${d}: will rename ~/.aib-server/${fromName} -> ${toName} and rewrite the Windows path in its json files.`,
        );
        moves.push(async () => {
          const r = await deps.wslRun!(d, WSL_MOVE, [
            opts.wslRoot,
            fromName,
            toName,
            ...sedArgs(fromPath, toPath),
          ]);
          if (r.code !== 0) {
            throw new Error(`WSL ${d}: the rename failed (exit ${r.code})`);
          }
          lines.push(`WSL ${d}: ${r.out.trim()}`);
        });
      }
    } else {
      lines.push(`WSL ${d}: unexpected answer "${state}"; skipped.`);
    }
  }
  return { refused, moves };
}

// ---- main flow ---------------------------------------------------------------------------------------------------------------------
const two = (n: number) => String(n).padStart(2, "0");
const dateOf = (d: Date) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const timeOf = (d: Date) =>
  `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;

function holdersLines(holders: { p: ProcInfo; why: string }[]): string[] {
  const out = [
    "REFUSED: these processes use the AIB data folder (the script never ends processes):",
  ];
  for (const { p, why } of holders) {
    out.push(`    ${p.name} (PID ${p.pid}): ${why}`);
  }
  out.push(
    "  Quit AIB first (its window and tray icon), wait a few seconds, then quit what is left from the list:",
    WIN
      ? "  Task Manager > Details tab > select the PID > End task, or in a terminal: taskkill /PID <pid>"
      : "  in a terminal: kill <pid>",
    "  Then run this script again.",
  );
  return out;
}

export async function run(opts: Opts, deps: Deps): Promise<Result> {
  const lines: string[] = [];
  const say = (s: string) => lines.push(s);
  const oldPath = pathOf(opts.parent, opts.legacy);
  const newPath = pathOf(opts.parent, opts.current);
  const fail = (): Result => ({ code: 1, lines });
  const now = deps.now();

  if (opts.undo) return await undo(opts, deps, lines, oldPath, newPath);

  say(
    `AIB data folder rename${
      opts.dryRun ? " (dry run: nothing is changed)" : ""
    }`,
  );
  say(`  from ${oldPath}`);
  say(`  to   ${newPath}`);

  if (!isDir(oldPath)) {
    if (isDir(newPath)) {
      say(
        `Nothing to do: ${newPath} already exists and ${oldPath} does not. AIB is already using the new name.`,
      );
      return { code: 0, lines };
    }
    say(
      `Nothing to do: there is no ${oldPath}. A new AIB starts with ${newPath} by itself.`,
    );
    return { code: 0, lines };
  }
  if (lstat(newPath)) {
    say(
      `REFUSED: ${newPath} already exists. AIB would use it and ignore ${opts.legacy}. Move or delete it yourself if it is not wanted, then run again.`,
    );
    return fail();
  }

  const holders = findHolders(await deps.list(), oldPath, deps.checkNames, [
    Deno.pid,
  ]);
  if (holders.length) {
    for (const l of holdersLines(holders)) say(l);
    if (!opts.dryRun) return fail();
    say("(Dry run: the plan below is what would happen once those are quit.)");
  } else say("No AIB, keeper or agent process uses the folder.");

  const stats = treeStats(oldPath);
  say(`Folder size: ${fmtStats(stats)}.`);
  const stamp = dateOf(now);
  let backup = pathOf(opts.parent, `${opts.legacy}.old-${stamp}`);
  if (lstat(backup)) {
    backup = pathOf(opts.parent, `${opts.legacy}.old-${stamp}-${timeOf(now)}`);
  }

  const wslLines: string[] = [];
  const wsl = await wslStep(opts, deps, oldPath, newPath, wslLines);

  if (opts.dryRun) {
    say("Plan:");
    say(`  1. copy ${oldPath} -> ${newPath} and compare file count and size`);
    say(
      `  2. rewrite the old folder path inside *.json / *.jsonl / *.toml state files of the copy (not worktrees/, agents/, keeper/, scratch/)`,
    );
    say(
      `  3. git worktree repair for ${
        worktreeFolders(oldPath).length
      } AIB worktree(s)`,
    );
    say(`  4. rename ${oldPath} -> ${backup}`);
    for (const l of wslLines) say("  WSL: " + l);
    say("Nothing was changed. Run without --dry-run to do it.");
    return { code: wsl.refused ? 1 : 0, lines };
  }
  if (wsl.refused) {
    for (const l of wslLines) say(l);
    return fail();
  }

  // rename probe: a folder with an open handle inside cannot be renamed on Windows; find out before copying
  const probe = pathOf(opts.parent, `${opts.legacy}.probe-${Deno.pid}`);
  try {
    Deno.renameSync(oldPath, probe);
    Deno.renameSync(probe, oldPath);
  } catch (error) {
    if (isDir(probe) && !isDir(oldPath)) Deno.renameSync(probe, oldPath);
    say(
      `REFUSED: ${oldPath} cannot be renamed right now (${
        (error as Error).message
      }). Something still has it open. Nothing was changed.`,
    );
    return fail();
  }

  let created = false;
  try {
    Deno.mkdirSync(newPath, { mode: 0o700 });
    created = true;
    makeOwnerOnly(newPath);
    say("1. Copying (this can take a minute)...");
    await copyTree(oldPath, newPath);
    const after = treeStats(newPath);
    if (
      after.files !== stats.files || after.bytes !== stats.bytes ||
      after.dirs !== stats.dirs
    ) {
      throw new Error(
        `the copy does not match: original ${fmtStats(stats)}; copy ${
          fmtStats(after)
        }`,
      );
    }
    say(`   copied and verified: ${fmtStats(after)}`);
    say("2. Rewriting the old folder path in state files of the copy...");
    const changed = rewritePaths(newPath, oldPath, newPath);
    say(`   ${changed.length} file(s) changed`);
    say("3. Repairing AIB worktrees...");
    await repairWorktrees(newPath, lines);
    say(`4. Renaming the old folder to ${backup}`);
    Deno.renameSync(oldPath, backup);
  } catch (error) {
    say(`FAILED: ${(error as Error).message}`);
    if (created && isDir(oldPath) && lstat(newPath)) {
      try {
        Deno.removeSync(newPath, { recursive: true });
        say(
          `The partial copy ${newPath} was removed. ${oldPath} is untouched. Nothing else changed.`,
        );
      } catch (e) {
        say(
          `Could not remove the partial copy ${newPath} (${
            (e as Error).message
          }). Delete it by hand before starting AIB; ${oldPath} is untouched.`,
        );
      }
    }
    return fail();
  }
  try {
    for (const move of wsl.moves) await move();
    for (const l of wslLines) say(l);
  } catch (error) {
    for (const l of wslLines) say(l);
    say(
      `WARNING: ${
        (error as Error).message
      }. The Windows folder is done; fix the distro by hand or run --undo.`,
    );
    return fail();
  }
  say("");
  say("Done. What happened:");
  say(
    `  - ${oldPath} was copied to ${newPath} (${stats.files} files, ${
      fmtBytes(stats.bytes)
    }), verified, paths rewritten, worktrees repaired.`,
  );
  say(`  - the old folder is now ${backup} (nothing was deleted).`);
  say(`To undo: deno run -A work/migrate/rename_data_folder.ts --undo`);
  say(`When you are happy with the new folder, delete ${backup} by hand.`);
  return { code: 0, lines };
}

async function undo(
  opts: Opts,
  deps: Deps,
  lines: string[],
  oldPath: string,
  newPath: string,
): Promise<Result> {
  const say = (s: string) => lines.push(s);
  const fail = (): Result => ({ code: 1, lines });
  say(
    `AIB data folder rename: UNDO${
      opts.dryRun ? " (dry run: nothing is changed)" : ""
    }`,
  );
  const prefix = `${opts.legacy}.old-`;
  const backups = isDir(opts.parent)
    ? [...Deno.readDirSync(opts.parent)].filter((e) =>
      e.isDirectory && e.name.startsWith(prefix)
    ).map((e) => e.name).sort()
    : [];
  if (!backups.length) {
    say(
      `Nothing to undo: there is no ${prefix}<date> folder in ${opts.parent}.`,
    );
    return fail();
  }
  const backup = pathOf(opts.parent, backups[backups.length - 1]);
  if (lstat(oldPath)) {
    say(
      `REFUSED: ${oldPath} exists again. Undo would have to overwrite it. Move it away yourself, then run again.`,
    );
    return fail();
  }
  if (!isDir(newPath)) {
    say(
      `REFUSED: ${newPath} is not there, so there is nothing to set aside. The old folder is ${backup}; rename it to ${opts.legacy} by hand if you want it back.`,
    );
    return fail();
  }
  const holders = findHolders(await deps.list(), newPath, deps.checkNames, [
    Deno.pid,
  ]);
  if (holders.length) {
    for (const l of holdersLines(holders)) say(l);
    if (!opts.dryRun) return fail();
  }
  const aside = pathOf(
    opts.parent,
    `${opts.current}.undone-${dateOf(deps.now())}-${timeOf(deps.now())}`,
  );
  const wslLines: string[] = [];
  const wsl = await wslStep(opts, deps, newPath, oldPath, wslLines);
  say(`  1. rename ${newPath} -> ${aside}`);
  say(`  2. rename ${backup} -> ${oldPath}`);
  say("  3. git worktree repair for the worktrees in the restored folder");
  for (const l of wslLines) say("  WSL: " + l);
  if (opts.dryRun) {
    say("Nothing was changed.");
    return { code: wsl.refused ? 1 : 0, lines };
  }
  if (wsl.refused) return fail();
  try {
    Deno.renameSync(newPath, aside);
    Deno.renameSync(backup, oldPath);
  } catch (error) {
    say(`FAILED: ${(error as Error).message}`);
    if (isDir(aside) && !lstat(newPath) && isDir(backup)) {
      Deno.renameSync(aside, newPath);
    }
    return fail();
  }
  say(
    `Restored ${oldPath}; the new folder is kept as ${aside} (it holds anything done in AIB since the rename).`,
  );
  await repairWorktrees(oldPath, lines);
  try {
    for (const move of wsl.moves) await move();
  } catch (error) {
    say(`WARNING: ${(error as Error).message}`);
  }
  for (const l of wslLines) say(l);
  say("Done. Start AIB: it uses the old folder again.");
  return { code: 0, lines };
}

// ---- command line ------------------------------------------------------------------------------------------------------------------
async function distroList(): Promise<string[]> {
  const r = await new Deno.Command("wsl.exe", {
    args: ["-l", "-q"],
    env: { WSL_UTF8: "1" },
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!r.success) return [];
  return DEC.decode(r.stdout).replace(/\0/g, "").split(/\r?\n/).map((s) =>
    s.trim()
  ).filter((s) => s && !/^docker-desktop/i.test(s));
}

const realWslRun: WslRun = async (distro, script, args) => {
  const r = await new Deno.Command("wsl.exe", {
    args: ["-d", distro, "-e", "/bin/sh", "-c", script, "sh", ...args],
    env: { WSL_UTF8: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: r.code,
    out: DEC.decode(r.stdout) + (r.success ? "" : DEC.decode(r.stderr)),
  };
};

export function parseArgs(argv: string[]): Opts | string {
  const names = userStateDirNames();
  let parent = "";
  let dryRun = false, undoFlag = false, wsl = true, wslRoot = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--undo") undoFlag = true;
    else if (a === "--no-wsl") wsl = false;
    else if (a === "--parent") parent = argv[++i] ?? "";
    else if (a === "--wsl-root") wslRoot = argv[++i] ?? "";
    else {return `Unknown option: ${a}\nusage: deno run -A work/migrate/rename_data_folder.ts [--dry-run] [--undo] [--no-wsl]`;}
  }
  const dirOf = (p: string) =>
    p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
  const base = (p: string) =>
    p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
  return {
    parent: parent || dirOf(names.current),
    current: base(names.current),
    legacy: base(names.legacy),
    dryRun,
    undo: undoFlag,
    wsl,
    wslRoot,
  };
}

if (import.meta.main && !Deno.env.get("AIB_RENAME_TEST")) {
  // ON HOLD 2026-11-24: on Windows the new name %LOCALAPPDATA%\AIB is the app's install folder; a new data-folder name is pending.
  console.error("This script is on hold: the new data-folder name collides with AIB's install folder. Nothing was changed.");
  Deno.exit(2);
}
if (import.meta.main) {
  const opts = parseArgs(Deno.args);
  if (typeof opts === "string") {
    console.error(opts);
    Deno.exit(1);
  }
  const res = await run(opts, {
    list: realLister,
    wslDistros: WIN ? distroList : null,
    wslRun: WIN ? realWslRun : null,
    now: () => new Date(),
    checkNames: true,
  });
  for (const l of res.lines) console.log(l);
  Deno.exit(res.code);
}
