/**
 * One-off migration for the owner's machine (AIB 0.13.0, owner 2026-11-17): the project's local-only folder `private/` becomes
 * `aib-shared/`, and AIB-made worktrees get a link named `aib-shared` to the main folder's real one instead of their own `private`
 * folder or junction. The app itself never migrates (owner rule: one-time migrations are scripts he runs).
 *
 * For every project in AIB's added-projects list (<data>\studio-added-projects.json; WSL projects through wsl.exe, natively in their
 * distro) and, with the default data folder, C:\Users\sirku\Documents\Codex\AIB itself:
 *   1. `private/` -> `aib-shared/` in the project folder, only when AIB's block of the repository's .git/info/exclude names it
 *      (`/<prefix>private`): a `private/` the project commits, or one AIB never set up, is the user's own and is left alone.
 *      Refused (and listed) when both `private/` and `aib-shared/` exist.
 *   2. AIB's exclude line `/<prefix>private` -> `/<prefix>aib-shared`, in place, inside AIB's block only; every other byte of the
 *      file is kept. The exclude file is backed up first, next to it: `exclude.before-aib-shared-<stamp>`.
 *   3. Every AIB-made worktree of the repository (branch studio/...): its `private` link or junction is removed (the link only,
 *      never what it points at); an empty `private/` folder is removed; a `private/` folder with files has them moved into the main
 *      folder's `aib-shared/` (never overwriting: a clash gets "<name> (from <worktree>)<ext>"); then the worktree gets its
 *      `aib-shared` link (a directory junction on Windows, a symlink in WSL).
 *
 * Usage (from the repo folder; AIB and its keeper must be quit):
 *   deno run -A --config outputs/agent-studio/deno.json work/migrate/rename_private_to_aib_shared.ts           dry run: prints the plan
 *   deno run -A --config outputs/agent-studio/deno.json work/migrate/rename_private_to_aib_shared.ts --apply   does it
 * Options: --data <AIB data folder> (default %LOCALAPPDATA%\AgentStudio; another folder leaves out the AIB repo below, so a test never
 * touches it), --project <folder> (repeatable: also this project), --no-wsl (skip WSL projects).
 * Safe to run again: whatever is done is skipped. Exit code 1 when anything was refused.
 */
import { tryLockNow } from '../../outputs/agent-studio/server/platform/lock.ts';
import { LOCK_FILE } from '../../outputs/agent-studio/server/desktop/single_instance.ts';
import { keeperRunning } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pathOf, userStateDir } from '../../outputs/agent-studio/server/state/paths.ts';
import { wslLocOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { gitPath } from '../../outputs/agent-studio/server/worktrees/changes.ts';
import { BLOCK_END, BLOCK_START, escapeLine, moveInto } from '../../outputs/agent-studio/server/worktrees/local_only.ts';
import { linksTo } from '../../outputs/agent-studio/server/worktrees/shared_link.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';

const WIN = Deno.build.os === 'windows';
export const AIB_REPO = 'C:\\Users\\sirku\\Documents\\Codex\\AIB';
const OLD = 'private', NEW = 'aib-shared';

export interface Options {
  apply: boolean;
  data: string;
  defaultData: boolean;
  extra: string[];
  wsl: boolean;
}
export interface Report {
  lines: string[];
  refused: number;
}

function parseArgs(args: string[]): Options {
  let apply = false, data = '', wsl = true;
  const extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') apply = true;
    else if (a === '--no-wsl') wsl = false;
    else if (a === '--data') data = args[++i] ?? '';
    else if (a === '--project') extra.push(args[++i] ?? '');
    else throw new Error(`Unknown option: ${a}`);
  }
  const defaultData = !data;
  return { apply, data: data || userStateDir(), defaultData, extra: extra.filter(Boolean), wsl };
}

// ---- AIB must be quit ----------------------------------------------------------------------------------------------------------
const held: Deno.FsFile[] = [];
/** '' when no AIB runs for this data folder, else what does. On success the data folder's lock is held until the script ends. */
export async function refuseWhileRunning(data: string): Promise<string> {
  if (keeperRunning(data)) return "AIB's keeper is running for this data folder";
  try {
    // the lock every AIB holds on its data folder while it runs (desktop/single_instance.ts): taken here, AIB cannot start meanwhile
    held.push(await tryLockNow(pathOf(data, LOCK_FILE), true));
  } catch {
    return 'AIB is running (its data folder is locked)';
  }
  return '';
}
export function releaseLocks(): void {
  for (const f of held.splice(0)) {
    try {
      f.close();
    } catch { /* closed */ }
  }
}

// ---- the projects --------------------------------------------------------------------------------------------------------------
/** The added projects' paths (Windows folders and WSL refs), read only (the app's list is never written here). */
export function addedProjects(data: string): string[] {
  for (const name of ['studio-added-projects.json', 'studio-added-projects.backup.json']) {
    try {
      const raw = JSON.parse(Deno.readTextFileSync(pathOf(data, name)));
      const added = raw && typeof raw === 'object' ? raw.added : null;
      if (!added || typeof added !== 'object') continue;
      return Object.values(added as Record<string, { path?: unknown }>).map((e) => (typeof e?.path === 'string' ? e.path : '')).filter(Boolean);
    } catch { /* missing or unreadable: the backup, else none */ }
  }
  return [];
}

// ---- git (Windows side) --------------------------------------------------------------------------------------------------------
const dec = new TextDecoder();
function git(args: string[], cwd: string): { code: number; out: string } {
  const bin = gitPath();
  if (!bin) return { code: -1, out: '' };
  try {
    const r = new Deno.Command(bin, {
      args: ['-c', 'core.quotepath=off', '--no-pager', ...args],
      cwd,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }).outputSync();
    return { code: r.code, out: dec.decode(r.stdout) };
  } catch {
    return { code: -1, out: '' };
  }
}

function lstat(p: string): Deno.FileInfo | null {
  try {
    return Deno.lstatSync(p);
  } catch {
    return null;
  }
}

/** The exclude file's bytes with AIB's `old` line turned into `next` inside AIB's block (null: not there). Keeps every other byte. */
export function renamedLine(bytes: Uint8Array, old: string, next: string): Uint8Array | null {
  const text = dec.decode(bytes);
  const lines = text.split('\n');
  let inBlock = false, done = false;
  for (let i = 0; i < lines.length; i++) {
    const bare = lines[i].replace(/\r$/, '');
    const t = bare.trim();
    if (t === BLOCK_START) inBlock = true;
    else if (t === BLOCK_END) inBlock = false;
    else if (inBlock && bare === old) {
      lines[i] = next + (lines[i].endsWith('\r') ? '\r' : '');
      done = true;
    }
  }
  return done ? new TextEncoder().encode(lines.join('\n')) : null;
}

/** True when AIB's block names `line` exactly. */
function blockHas(text: string, line: string): boolean {
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const bare = raw.replace(/\r$/, ''), t = bare.trim();
    if (t === BLOCK_START) inBlock = true;
    else if (t === BLOCK_END) inBlock = false;
    else if (inBlock && bare === line) return true;
  }
  return false;
}

function isEmptyDir(p: string): boolean {
  try {
    return [...Deno.readDirSync(p)].length === 0;
  } catch {
    return false;
  }
}

/** One Windows project. Lines go to `r`; nothing is changed unless o.apply. */
export async function migrateWindows(project: string, o: Options, r: Report, stamp: string): Promise<void> {
  const say = (t: string): void => void r.lines.push(`  ${t}`);
  r.lines.push(`${project}`);
  if (!osp.isdir(project)) return say('skip: the folder is not there');
  const info = git(['rev-parse', '--show-prefix', '--git-path', 'info/exclude'], project);
  const parts = info.out.split(/\r?\n/);
  if (info.code !== 0 || parts.length < 2 || !parts[1].trim()) return say('skip: not a git project');
  const prefix = parts[0].trim();
  const excludeRaw = parts[1].trim();
  const exclude = osp.normpath(osp.isabs(excludeRaw) ? excludeRaw : osp.join(project, excludeRaw));
  const oldLine = escapeLine(prefix, OLD), newLine = escapeLine(prefix, NEW);
  let bytes: Uint8Array | null = null;
  try {
    bytes = Deno.readFileSync(exclude);
  } catch { /* no exclude file */ }
  const text = bytes ? dec.decode(bytes) : '';
  const hasOld = blockHas(text, oldLine), hasNew = blockHas(text, newLine);
  const oldDir = osp.join(project, OLD), newDir = osp.join(project, NEW);
  const oldThere = !!lstat(oldDir)?.isDirectory, newThere = !!lstat(newDir);
  if (!hasOld && !hasNew) return say(`skip: AIB's block in ${exclude} names neither ${oldLine} nor ${newLine} (never set up, or private/ is the project's own)`);
  if (hasOld && git(['ls-files', '--', OLD], project).out.trim()) return say(`skip: the project commits ${OLD}/, so it is the project's own`);
  if (oldThere && newThere) {
    r.refused++;
    say(`REFUSED: both ${oldDir} and ${newDir} exist; merge them by hand, then run again`);
    return;
  }
  // 1. the folder
  if (oldThere && hasOld) {
    say(`${o.apply ? 'renamed' : 'would rename'} ${oldDir} -> ${newDir}`);
    if (o.apply) Deno.renameSync(oldDir, newDir);
  } else if (newThere) say(`ok: ${newDir} is there`);
  else say(`no ${OLD}/ folder (AIB makes ${NEW}/ when a chat needs it)`);
  // 2. the exclude line
  if (hasOld && bytes) {
    const backup = `${exclude}.before-aib-shared-${stamp}`;
    say(`${o.apply ? 'backed up' : 'would back up'} ${exclude} -> ${backup}`);
    say(`${o.apply ? 'rewrote' : 'would rewrite'} AIB's line ${oldLine} -> ${newLine} in ${exclude}`);
    if (o.apply) {
      Deno.copyFileSync(exclude, backup);
      const next = hasNew ? renamedLine(bytes, oldLine, '') : renamedLine(bytes, oldLine, newLine);
      // both lines (an earlier half run): the old one goes, as an empty line inside the block (git skips blank lines)
      Deno.writeFileSync(exclude + '.aib-tmp', next!);
      Deno.renameSync(exclude + '.aib-tmp', exclude);
    }
  } else say(`ok: AIB's line is ${newLine}`);
  // 3. AIB-made worktrees of the repository (branch studio/...)
  const list = git(['worktree', 'list', '--porcelain'], project).out.split(/\r?\n/);
  const trees: { path: string; branch: string }[] = [];
  let cur = '';
  for (const line of list) {
    if (line.startsWith('worktree ')) cur = osp.normpath(line.slice(9));
    else if (line.startsWith('branch refs/heads/studio/') && cur) trees.push({ path: cur, branch: line.slice(18) });
  }
  const segs = prefix.split('/').filter(Boolean);
  for (const t of trees) {
    if (!osp.isdir(t.path)) continue;
    const at = osp.join(t.path, ...segs);
    const oldIn = osp.join(at, OLD), link = osp.join(at, NEW);
    const st = lstat(oldIn);
    if (st?.isSymlink) {
      say(`${o.apply ? 'removed' : 'would remove'} the old link ${oldIn} (the link only) [${t.branch}]`);
      if (o.apply) Deno.removeSync(oldIn);
    } else if (st?.isDirectory) {
      if (isEmptyDir(oldIn)) {
        say(`${o.apply ? 'removed' : 'would remove'} the empty folder ${oldIn} [${t.branch}]`);
        if (o.apply) Deno.removeSync(oldIn);
      } else {
        say(`${o.apply ? 'moved' : 'would move'} the files of ${oldIn} into ${newDir} (never overwriting) [${t.branch}]`);
        if (o.apply) {
          Deno.mkdirSync(newDir, { recursive: true });
          const failed: string[] = [];
          for (const e of [...Deno.readDirSync(oldIn)]) {
            // per child: moveInto wants both sides to end with the same relative path
            const done = await moveInto(osp.join(oldIn, e.name), osp.join(newDir, e.name), osp.basename(t.path), e.name);
            for (const [from, to] of done.moved) say(`  ${OLD}/${from} -> ${NEW}/${to}`);
            failed.push(...done.failed);
          }
          if (failed.length) {
            r.refused++;
            say(`  REFUSED: could not move ${failed.join(', ')}; move them by hand`);
          }
          try {
            Deno.removeSync(oldIn, { recursive: false });
          } catch { /* something stayed (reported above) */ }
        }
      }
    }
    if (linksTo(link, newDir)) say(`ok: ${link} links to ${newDir}`);
    else if (lstat(link)) {
      r.refused++;
      say(`REFUSED: ${link} exists and is not a link to ${newDir}; look at it by hand`);
    } else {
      say(`${o.apply ? 'linked' : 'would link'} ${link} -> ${newDir} (${WIN ? 'junction' : 'symlink'}) [${t.branch}]`);
      if (o.apply) {
        Deno.mkdirSync(newDir, { recursive: true });
        Deno.symlinkSync(newDir, link, WIN ? { type: 'junction' } : undefined);
      }
    }
  }
  if (!trees.length) say('no AIB-made worktrees');
}

// ---- WSL projects: the same steps in bash, run in the distro through wsl.exe ----------------------------------------------------
/** The bash script for one WSL project: $1 main folder (Linux), $2 1 to apply, $3 the backup stamp. Prints the same kind of lines. */
export const WSL_SCRIPT = String.raw`
set -u
main="$1"; apply="$2"; stamp="$3"
OLD=private; NEW=aib-shared
BS='# AIB: local only (shown in every chat; never committed)'; BE='# AIB: end'
say() { printf '  %s\n' "$*"; }
verb() { if [ "$apply" = 1 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
printf '%s\n' "$main"
[ -d "$main" ] || { say 'skip: the folder is not there'; exit 0; }
cd "$main" || exit 0
prefix=$(git rev-parse --show-prefix 2>/dev/null) || { say 'skip: not a git project'; exit 0; }
excl=$(git rev-parse --git-path info/exclude); case "$excl" in /*) ;; *) excl="$main/$excl";; esac
oldl="/$prefix$OLD"; newl="/$prefix$NEW"
inblock() { [ -f "$excl" ] && awk -v s="$BS" -v e="$BE" -v l="$1" '{sub(/\r$/,"")} $0==s{b=1;next} $0==e{b=0;next} b&&$0==l{f=1} END{exit f?0:1}' "$excl"; }
hasold=0; hasnew=0; inblock "$oldl" && hasold=1; inblock "$newl" && hasnew=1
if [ $hasold = 0 ] && [ $hasnew = 0 ]; then say "skip: AIB's block in $excl names neither $oldl nor $newl (never set up, or private/ is the project's own)"; exit 0; fi
if [ $hasold = 1 ] && [ -n "$(git ls-files -- "$OLD")" ]; then say "skip: the project commits $OLD/, so it is the project's own"; exit 0; fi
if [ -d "$OLD" ] && [ ! -L "$OLD" ] && [ -e "$NEW" ]; then say "REFUSED: both $main/$OLD and $main/$NEW exist; merge them by hand, then run again"; exit 3; fi
if [ -d "$OLD" ] && [ ! -L "$OLD" ] && [ $hasold = 1 ]; then
  say "$(verb renamed 'would rename') $main/$OLD -> $main/$NEW"; [ "$apply" = 1 ] && mv "$OLD" "$NEW"
elif [ -e "$NEW" ]; then say "ok: $main/$NEW is there"; else say "no $OLD/ folder (AIB makes $NEW/ when a chat needs it)"; fi
if [ $hasold = 1 ]; then
  say "$(verb 'backed up' 'would back up') $excl -> $excl.before-aib-shared-$stamp"
  say "$(verb rewrote 'would rewrite') AIB's line $oldl -> $newl in $excl"
  if [ "$apply" = 1 ]; then
    cp -p "$excl" "$excl.before-aib-shared-$stamp"
    rep="$newl"; [ $hasnew = 1 ] && rep=''
    awk -v s="$BS" -v e="$BE" -v o="$oldl" -v n="$rep" '{cr=""; line=$0; if (sub(/\r$/,"",line)) cr="\r"} line==s{b=1} line==e{b=0} b&&line==o{print n cr; next} {print}' "$excl" > "$excl.aib-tmp" && mv "$excl.aib-tmp" "$excl"
  fi
else say "ok: AIB's line is $newl"; fi
found=0; wt=''
git worktree list --porcelain | while IFS= read -r line; do
  case "$line" in
    'worktree '*) wt="\${line#worktree }";;
    'branch refs/heads/studio/'*)
      [ -d "$wt" ] || continue
      found=1; br="\${line#branch refs/heads/}"; at="$wt/\${prefix%/}"; [ -n "$prefix" ] || at="$wt"
      o="$at/$OLD"; l="$at/$NEW"
      if [ -L "$o" ]; then say "$(verb removed 'would remove') the old link $o (the link only) [$br]"; [ "$apply" = 1 ] && rm -f "$o"
      elif [ -d "$o" ]; then
        if [ -z "$(ls -A "$o")" ]; then say "$(verb removed 'would remove') the empty folder $o [$br]"; [ "$apply" = 1 ] && rmdir "$o"
        else
          say "$(verb moved 'would move') the files of $o into $main/$NEW (never overwriting) [$br]"
          if [ "$apply" = 1 ]; then
            mkdir -p "$main/$NEW"
            (cd "$o" && find . -type f -o -type l) | while IFS= read -r f; do
              d="$main/$NEW/\${f#./}"
              if [ -e "$d" ] || [ -L "$d" ]; then say "  REFUSED: $d exists; $o/\${f#./} stays, move it by hand"
              else mkdir -p "$(dirname "$d")" && mv "$o/\${f#./}" "$d" && say "  \${f#./} -> $NEW/\${f#./}"; fi
            done
            find "$o" -depth -type d -empty -delete 2>/dev/null
          fi
        fi
      fi
      if [ -L "$l" ] && [ "$(readlink "$l")" = "$main/$NEW" ]; then say "ok: $l links to $main/$NEW"
      elif [ -e "$l" ] || [ -L "$l" ]; then say "REFUSED: $l exists and is not a link to $main/$NEW; look at it by hand"
      else say "$(verb linked 'would link') $l -> $main/$NEW (symlink) [$br]"; [ "$apply" = 1 ] && mkdir -p "$main/$NEW" && ln -s "$main/$NEW" "$l"; fi
      ;;
  esac
done
`.replaceAll('\\${', '${');

/** One WSL project (its ref), through wsl.exe. `runner` is swappable (tests run the script with a local bash). */
export async function migrateWsl(
  ref: string,
  o: Options,
  r: Report,
  stamp: string,
  runner: (distro: string, args: string[]) => Promise<{ code: number; out: string }> = wslRun,
): Promise<void> {
  const loc = wslLocOf(ref);
  if (!loc) return void r.lines.push(`${ref}\n  skip: not a WSL ref`);
  const res = await runner(loc.distro, ['bash', '-c', WSL_SCRIPT, 'bash', loc.linuxPath, o.apply ? '1' : '0', stamp]);
  const out = res.out.replace(/\n+$/, '');
  r.lines.push(`[${loc.distro}] ` + (out || `${loc.linuxPath}\n  skip: the distro gave no answer (exit ${res.code})`));
  if (res.code === 3 || /REFUSED:/.test(out)) r.refused++;
}

async function wslRun(distro: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = await new Deno.Command('wsl.exe', { args: ['-d', distro, '--exec', ...args], stdin: 'null', stdout: 'piped', stderr: 'piped' }).output();
    return { code: p.code, out: dec.decode(p.stdout) + dec.decode(p.stderr) };
  } catch (error) {
    return { code: -1, out: `  skip: wsl.exe could not run (${error instanceof Error ? error.message : error})` };
  }
}

// ---- main ----------------------------------------------------------------------------------------------------------------------
export async function run(o: Options, wslRunner?: (distro: string, args: string[]) => Promise<{ code: number; out: string }>): Promise<Report> {
  const r: Report = { lines: [], refused: 0 };
  const why = await refuseWhileRunning(o.data);
  if (why) {
    r.lines.push(`Refused: ${why}. Quit AIB (and its keeper) first.`);
    r.refused++;
    return r;
  }
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const projects = [...addedProjects(o.data), ...o.extra, ...(o.defaultData ? [AIB_REPO] : [])];
    const seen = new Set<string>();
    r.lines.push(o.apply ? 'Renaming private/ to aib-shared/:' : 'Dry run (nothing changes; --apply does it):');
    for (const p of projects) {
      const key = wslLocOf(p) ? p.toLowerCase() : osp.normcase(osp.normpath(p));
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (wslLocOf(p)) {
          if (o.wsl) await migrateWsl(p, o, r, stamp, wslRunner);
          else r.lines.push(`${p}\n  skip: --no-wsl`);
        } else await migrateWindows(p, o, r, stamp);
      } catch (error) {
        r.refused++;
        r.lines.push(`  FAILED: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (!projects.length) r.lines.push('No projects found.');
  } finally {
    releaseLocks();
  }
  return r;
}

if (import.meta.main) {
  const o = parseArgs(Deno.args);
  const r = await run(o);
  for (const l of r.lines) console.log(l);
  if (r.refused) console.log(`\n${r.refused} refused or failed; nothing else was stopped by it.`);
  Deno.exit(r.refused ? 1 : 0);
}
