/**
 * The re-file core of the one-off folder-chats migration (folder_chats_migrate.ts). It lived in the app as worktrees/refile.ts until
 * the owner asked for no migration code in the app (2026-11-16); only the script uses it now.
 *
 * What the P0 experiment proved (private/designs/worktree-model/refile-experiment.md):
 *   - Claude Code: move `projects/<enc W>/<id>.jsonl` (and the `<id>/` side folder) to `projects/<enc P>/` AND rewrite every
 *     `"cwd"` W -> P, so the listing for P has it with cwd P (the listing's cwd is read from the transcript lines).
 *   - Codex: open the chat once in the project folder (`session/load` with cwd = P, no prompt): Codex re-indexes it itself. Nothing
 *     here writes Codex's files or its SQLite index.
 *
 * Safety (never lose a transcript):
 *   - every original is first copied to `<AIB data>
efiled\<provider>\<id>.jsonl` and that backup is never deleted;
 *   - all or nothing: the new file is written beside the target as `.tmp` and renamed in; if any later step fails, the new file goes
 *     and the original stays where it was;
 *   - empty copy-named folders in `projects/` are removed only with a plain (non-recursive) rmdir, which fails on any content: a
 *     folder that still holds `memory/` or any file is kept. No `.jsonl` is ever deleted by that sweep.
 *
 * The mapping `studio-moved-chats.json` (provider:sessionId -> project folder) is written here and only read by the app
 * (server/state/moved_chats.ts): Continue opens the chat in the project folder even when a page still sends the copy path.
 */
import { FileLock } from '../../outputs/agent-studio/server/platform/lock.ts';
import { readJsonFile, saveJson } from '../../outputs/agent-studio/server/state/json.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import { isDict } from '../../outputs/agent-studio/server/core/py.ts';
import { basename, isdir, isfile, join, normcase, normpath, SEP } from '../../outputs/agent-studio/server/platform/ospath.ts';
import { MOVED_FILE } from '../../outputs/agent-studio/server/state/moved_chats.ts';

export { MOVED_FILE };

export const REFILED_DIR = 'refiled';
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const key = (provider: string, sessionId: string) => `${provider}:${sessionId}`;
const folded = (p: string) => normcase(normpath(String(p)));

/** Claude Code's `projects/<name>` for a folder: every character that is not an ASCII letter or digit becomes '-'. */
export function claudeEncode(folder: string): string {
  return String(folder).replace(/[^A-Za-z0-9]/g, '-');
}

// ---- the moved-chats mapping ---------------------------------------------------------------------------------------------
export interface MovedChat {
  /** The project folder the chat now works in. */
  project: string;
  /** The copy folder it worked in before. */
  from: string;
  /** Why: 'migrated' (this script); older entries: 'merged', 'discarded', 'deleted', 'orphan'. */
  why: string;
  at: number;
  /** Where the transcript was re-filed ('' = not re-filed: the agent still finds it by id). */
  refiled: string;
  /** The untouched original ('' = none made). */
  backup: string;
}

function movedPath(stateDir: string): string {
  return pathOf(stateDir, MOVED_FILE);
}

/** {provider:sessionId: MovedChat}; anything malformed reads as empty. */
export function readMoved(stateDir: string): Record<string, MovedChat> {
  const [status, raw] = readJsonFile(movedPath(stateDir));
  const out: Record<string, MovedChat> = {};
  const chats = status === 'ok' && isDict(raw) && isDict(raw.chats) ? raw.chats : {};
  for (const [k, v] of Object.entries(chats)) {
    if (!isDict(v) || !str(v.project)) continue;
    Object.defineProperty(out, k, {
      value: {
        project: str(v.project),
        from: str(v.from),
        why: str(v.why),
        at: Number(v.at) || 0,
        refiled: str(v.refiled),
        backup: str(v.backup),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The project folder a saved chat moved into (null: it did not move). */
export function movedTo(stateDir: string, provider: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const found = readMoved(stateDir)[key(provider, sessionId)];
  return found ? found.project : null;
}

/** Write (or update) one chat's mapping, under a cross-process lock. */
export async function recordMoved(stateDir: string, provider: string, sessionId: string, entry: MovedChat): Promise<void> {
  const lock = new FileLock(movedPath(stateDir) + '.lock', 10_000);
  await lock.acquire();
  try {
    const all = readMoved(stateDir);
    all[key(provider, sessionId)] = entry;
    saveJson(movedPath(stateDir), { version: 1, chats: all }, '.studio-moved-chats-');
  } finally {
    lock.release();
  }
}

// ---- backups -------------------------------------------------------------------------------------------------------------
/** Copy `file` to <AIB data>\refiled\<provider>\<id>.jsonl (or <id>.<n>.jsonl when one is already there); returns the backup. */
export function backup(stateDir: string, provider: string, sessionId: string, file: string): string {
  const dir = join(pathOf(stateDir, REFILED_DIR), provider);
  Deno.mkdirSync(dir, { recursive: true });
  let target = join(dir, `${sessionId}.jsonl`);
  for (let n = 2; isfile(target); n++) target = join(dir, `${sessionId}.${n}.jsonl`);
  Deno.copyFileSync(file, target); // never overwrites a backup: each one is kept forever
  return target;
}

// ---- Claude Code -----------------------------------------------------------------------------------------------------------
export interface RefileResult {
  /** 'moved', 'already' (it is filed under the project already), else why nothing moved. */
  outcome: 'moved' | 'already' | 'missing' | 'exists' | 'failed' | 'refused';
  message: string;
  /** The file it is filed at now (moved / already). */
  path: string;
  backup: string;
  /** The folder it was in (a copy-named folder that may now be empty). */
  fromFolder: string;
}

const CWD_FIELD = /("cwd"\s*:\s*)("(?:[^"\\]|\\.)*")/g;

/**
 * Every JSON `"cwd": "<W or under W>"` rewritten to the same place under P; other text is left byte for byte. Returns the new text
 * and how many fields changed.
 */
export function rewriteCwd(text: string, from: string, to: string): [string, number] {
  const w = folded(from).replace(/[\\/]+$/, '');
  const base = normpath(to).replace(/[\\/]+$/, '');
  let count = 0;
  const out = text.replace(CWD_FIELD, (whole, head: string, literal: string) => {
    let value: unknown;
    try {
      value = JSON.parse(literal);
    } catch {
      return whole;
    }
    if (typeof value !== 'string' || !value) return whole;
    const v = folded(value);
    let next: string | null = null;
    if (v === w) next = base;
    else if (v.startsWith(w + SEP) || v.startsWith(w + '/')) next = base + normpath(value).slice(w.length);
    if (next === null) return whole;
    count++;
    return head + JSON.stringify(next);
  });
  return [out, count];
}

/** The one `<id>.jsonl` under `root` (a direct child folder), searching the copy's encoded folder first. */
export function findClaudeFile(root: string, sessionId: string, from: string): string | null {
  const first = join(root, claudeEncode(from), `${sessionId}.jsonl`);
  if (isfile(first)) return first;
  if (!isdir(root)) return null;
  const hits: string[] = [];
  for (const entry of Deno.readDirSync(root)) {
    if (!entry.isDirectory) continue;
    const file = join(root, entry.name, `${sessionId}.jsonl`);
    if (isfile(file)) hits.push(file);
  }
  return hits.length === 1 ? hits[0] : null;
}

export interface ClaudeRefile {
  stateDir: string;
  /** The `projects` folder of Claude Code's config (CLAUDE_CONFIG_DIR\projects, ~/.claude/projects). */
  projectsRoot: string;
  sessionId: string;
  /** The copy folder (W) the chat worked in. */
  from: string;
  /** The project folder (P). */
  to: string;
}

/** Move one Claude Code transcript from the copy's folder to the project's, cwd rewritten. All or nothing; the backup is kept. */
export function refileClaude(job: ClaudeRefile): RefileResult {
  const { stateDir, projectsRoot, sessionId, from, to } = job;
  const fail = (outcome: RefileResult['outcome'], message: string, extra: Partial<RefileResult> = {}): RefileResult => ({
    outcome,
    message,
    path: '',
    backup: '',
    fromFolder: '',
    ...extra,
  });
  if (!SESSION_ID.test(sessionId)) return fail('refused', 'not a session id');
  if (!from || !to || folded(from) === folded(to)) return fail('refused', 'nothing to move');
  const destDir = join(projectsRoot, claudeEncode(to));
  const dest = join(destDir, `${sessionId}.jsonl`);
  const src = findClaudeFile(projectsRoot, sessionId, from);
  if (!src) return isfile(dest) ? fail('already', 'already filed under the project', { path: dest }) : fail('missing', 'no transcript found');
  const srcDir = src.slice(0, src.length - basename(src).length - 1);
  if (folded(srcDir) === folded(destDir)) return fail('already', 'already filed under the project', { path: dest });
  if (isfile(dest)) return fail('exists', 'the project folder already has a transcript with this id', { fromFolder: srcDir });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Deno.readFileSync(src));
  } catch (error) {
    return fail('failed', `could not read the transcript: ${error instanceof Error ? error.message : error}`, { fromFolder: srcDir });
  }
  let saved: string;
  try {
    saved = backup(stateDir, 'claude', sessionId, src);
  } catch (error) {
    return fail('failed', `could not back the transcript up: ${error instanceof Error ? error.message : error}`, { fromFolder: srcDir });
  }
  const [rewritten] = rewriteCwd(text, from, to);
  const tmp = dest + '.tmp';
  const sideFrom = join(srcDir, sessionId);
  const sideTo = join(destDir, sessionId);
  let wrote = false, sideMoved = false;
  try {
    Deno.mkdirSync(destDir, { recursive: true });
    Deno.writeTextFileSync(tmp, rewritten);
    Deno.renameSync(tmp, dest);
    wrote = true;
    if (isdir(sideFrom) && !isdir(sideTo)) {
      Deno.renameSync(sideFrom, sideTo); // subagent transcripts and tool results; `memory/` stays where it is
      sideMoved = true;
    }
    Deno.removeSync(src); // the original: its untouched copy is the backup
  } catch (error) {
    // roll back: the original stays where it was, the new file goes
    try {
      if (sideMoved) Deno.renameSync(sideTo, sideFrom);
    } catch { /* left beside the new place: nothing is lost */ }
    try {
      if (isfile(tmp)) Deno.removeSync(tmp);
      if (wrote && isfile(src)) Deno.removeSync(dest);
    } catch { /* best effort */ }
    return fail('failed', `could not move the transcript: ${error instanceof Error ? error.message : error}`, { backup: saved, fromFolder: srcDir });
  }
  return { outcome: 'moved', message: '', path: dest, backup: saved, fromFolder: srcDir };
}

// ---- Codex ---------------------------------------------------------------------------------------------------------------
/** The rollout file of a Codex session under CODEX_HOME\sessions (YYYY\MM\DD\rollout-…-<id>.jsonl), or null. */
export function findCodexRollout(codexHome: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const root = join(codexHome, 'sessions');
  if (!isdir(root)) return null;
  const want = `-${sessionId}.jsonl`;
  const walk = (dir: string, depth: number): string | null => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return null;
    }
    for (const e of entries) if (e.isFile && e.name.endsWith(want)) return join(dir, e.name);
    if (depth >= 4) return null;
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const hit = walk(join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}

export interface CodexRefile {
  stateDir: string;
  codexHome: string;
  sessionId: string;
  /** Opens the chat once in the project folder (session/load with cwd = P, no prompt) and closes it. */
  load(): Promise<void>;
}

/** Back the rollout up, then let Codex re-file it itself by opening it once in the project folder. Never writes Codex's files. */
export async function refileCodex(job: CodexRefile): Promise<RefileResult> {
  const rollout = findCodexRollout(job.codexHome, job.sessionId);
  const base = { path: '', backup: '', fromFolder: '' };
  if (!rollout) return { ...base, outcome: 'missing', message: 'no rollout found' };
  let saved: string;
  try {
    saved = backup(job.stateDir, 'codex', job.sessionId, rollout);
  } catch (error) {
    return { ...base, outcome: 'failed', message: `could not back the rollout up: ${error instanceof Error ? error.message : error}` };
  }
  try {
    await job.load();
  } catch (error) {
    return { ...base, backup: saved, outcome: 'failed', message: `could not open it in the project folder: ${error instanceof Error ? error.message : error}` };
  }
  return { outcome: 'moved', message: '', path: rollout, backup: saved, fromFolder: '' };
}

// ---- empty copy-named folders (4.6) -------------------------------------------------------------------------------------------
/**
 * Remove the folders in Claude Code's `projects/` whose name is the encoding of a path under this install's worktrees root, only
 * when completely empty (a plain rmdir, which fails on any content). Returns [removed, kept-with-content].
 */
export function cleanEmptyCopyFolders(projectsRoot: string, worktreesRoot: string): [string[], string[]] {
  const removed: string[] = [], kept: string[] = [];
  if (!isdir(projectsRoot) || !worktreesRoot) return [removed, kept];
  const prefix = claudeEncode(normpath(worktreesRoot).replace(/[\\/]+$/, '')) + '-';
  for (const entry of Deno.readDirSync(projectsRoot)) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    if (!entry.name.toLowerCase().startsWith(prefix.toLowerCase()) || entry.name.length <= prefix.length) continue;
    const dir = join(projectsRoot, entry.name);
    try {
      Deno.removeSync(dir); // not recursive: refused when the folder holds anything (memory/, a transcript, any file)
      removed.push(dir);
    } catch {
      kept.push(dir);
    }
  }
  return [removed, kept];
}

/** True when `folder` is a copy-named folder of this install: the encoding of a path under its worktrees root. */
export function isCopyNamed(folderName: string, worktreesRoot: string): boolean {
  const prefix = claudeEncode(normpath(worktreesRoot).replace(/[\\/]+$/, '')) + '-';
  return folderName.toLowerCase().startsWith(prefix.toLowerCase()) && folderName.length > prefix.length;
}
