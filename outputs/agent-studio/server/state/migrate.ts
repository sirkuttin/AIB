/**
 * One-time, restartable move of Agent Studio's data into the private per-user folder (migrate.py; same steps, same messages, same
 * files). See server/state/paths.ts for when it runs.
 *
 * migrate(source, target) either finishes completely or leaves the target untouched:
 *
 *   1. Preconditions. The old agent host (pid in source/agent-host.json) and any old web server (pid in source/artifact-web.json)
 *      must be gone, and every lease in source/session-leases/ must be acquirable. Leases are OS byte-range locks: they are only
 *      probed (and held during the copy so nobody can start a conversation meanwhile), never copied or read. A Python and a Deno
 *      lease holder exclude each other (platform/lock.ts).
 *      If a precondition fails nothing is copied and the result says state 'waiting'; the caller runs on the OLD folder this
 *      time and tries again at the next start.
 *   2. Copy into <target>.tmp-<pid>: every top-level studio-* file, artifacts/, agents/ and artifact-key-secret, byte for byte.
 *      agent-host.json, agent-host.log* and artifact-web.json are skipped; other folders (session-leases/, worktrees/, ...) are
 *      left behind and listed in the record. Absolute references to the old folder inside the copied JSON are rewritten.
 *   3. Verify every file (size and sha256 against what was read, and the source again so a change during the copy aborts).
 *   4. Write .migrated inside the copy, rename the copy into place (the commit), then write MIGRATED-TO.txt in the old folder.
 *      That note is the only change ever made to the old folder.
 *
 * A kill at any point before step 4's rename leaves no .migrated in the target, so the next start simply redoes it; leftover
 * <target>.tmp-<pid> folders of dead processes are removed (only ones carrying our .migrating mark).
 *
 * Importing this module registers migrate() with paths.ts (registerMigrate), so prepare() and adoptSandboxCopy() use it.
 */
import { createHash } from 'node:crypto';
import { getLogger } from '../core/log.ts';
import { pyCompare, pyJsonDumps } from '../core/py.ts';
import { INFO_NAME, pidAlive } from '../host/host_client.ts';
import { OwnershipConflict, SessionLease } from '../ownership/ownership.ts';
import { parseJson } from './json.ts';
import { ensurePrivateDir, MIGRATED_MARKER, type Migration, pathOf, registerMigrate, type Say } from './paths.ts';

const log = getLogger('migrate');

export const NOTE_NAME = 'MIGRATED-TO.txt';
export const TMP_MARK = '.migrating';
export const SKIP_EXACT: ReadonlySet<string> = new Set(['agent-host.json', 'artifact-web.json']);
export const SKIP_PREFIX = ['agent-host.log'] as const;
export const KEEP_EXACT = ['artifact-key-secret'] as const;
export const COPY_DIRS = ['artifacts', 'agents'] as const; // agents/: Studio-installed adapters

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';

export class MigrationAborted extends Error {
  override name = 'MigrationAborted';
  constructor(readonly state: string, readonly reason: string) {
    super(reason);
  }
}

/**
 * Thrown from on_file it is not turned into a 'failed' result but passes through, leaving the half-made copy behind (Python's tests
 * raise a BaseException there, which `except Exception` does not catch: a kill in the middle of the copy).
 */
export class MigrationKilled extends Error {
  override name = 'MigrationKilled';
}

function result(state: string, reason = '', source: string | null = null, extra: Record<string, unknown> = {}): Migration {
  return { state, reason, source: source ? String(source) : null, ...extra };
}

// ---- small file helpers (pathlib on this OS) ---------------------------------------------------
function stat(path: string): Deno.FileInfo | null {
  try {
    return Deno.statSync(path);
  } catch {
    return null;
  }
}

const exists = (path: string) => stat(path) !== null;
const isFile = (path: string) => stat(path)?.isFile === true;
const isDir = (path: string) => stat(path)?.isDirectory === true;

/** pathlib's name / parent for a normalized path. */
function splitName(path: string): [string, string] {
  const index = Math.max(path.lastIndexOf(SEP), WIN ? path.lastIndexOf('/') : -1);
  if (index < 0) return [WIN && /^[A-Za-z]:/.test(path) ? path.slice(0, 2) : '.', path.replace(/^[A-Za-z]:/, '')];
  const head = path.slice(0, index);
  const parent = !head || (WIN && /^[A-Za-z]:$/.test(head)) ? head + SEP : head;
  return [parent, path.slice(index + 1)];
}

/** Path ordering of entries in one folder: case-insensitive on Windows (pathlib compares normcased parts), by code point elsewhere. */
function pathOrder(a: string, b: string): number {
  return WIN ? pyCompare(a.toLowerCase(), b.toLowerCase()) : pyCompare(a, b);
}

function listNames(folder: string): string[] {
  return [...Deno.readDirSync(folder)].map((entry) => entry.name);
}

/** Path.write_text(text, encoding='utf-8'): text mode, so '\n' is written as '\r\n' on Windows. */
function writeText(path: string, text: string): void {
  Deno.writeTextFileSync(path, WIN ? text.replaceAll('\n', '\r\n') : text);
}

/** shutil.rmtree(path, ignore_errors=True) */
function rmtreeQuiet(path: string): void {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch { /* ignore_errors */ }
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function shaOf(path: string): string {
  return sha256(Deno.readFileSync(path));
}

/** Python's exception class name for a Deno error (the 'failed' reason is "<TypeName>: <message>"). */
function pyErrorName(error: unknown): string {
  if (error instanceof Deno.errors.NotFound) return 'FileNotFoundError';
  if (error instanceof Deno.errors.AlreadyExists) return 'FileExistsError';
  if (error instanceof Deno.errors.PermissionDenied) return 'PermissionError';
  if (error instanceof Deno.errors.NotADirectory) return 'NotADirectoryError';
  if (error instanceof Deno.errors.IsADirectory) return 'IsADirectoryError';
  if (error instanceof Error && Object.values(Deno.errors).some((kind) => error instanceof kind)) return 'OSError';
  return error instanceof Error ? error.name : 'Exception';
}

// ---- preconditions -----------------------------------------------------------------------------
/** The int 'pid' of a JSON file, or null (Python: isinstance(pid, int), so true/false count as 1/0). */
function readPid(path: string): number | null {
  let data: unknown;
  try {
    data = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Deno.readFileSync(path)).replace(/\r\n?/g, '\n'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const pid = (data as Record<string, unknown>).pid;
  if (typeof pid === 'boolean') return pid ? 1 : 0;
  return typeof pid === 'number' && Number.isInteger(pid) ? pid : null;
}

/** Path.suffix */
function suffix(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 && index < name.length - 1 ? name.slice(index) : '';
}

/** Hold every lease in source/session-leases. Returns the held leases; throws MigrationAborted('waiting') when one is taken. */
export async function acquireAllLeases(source: string): Promise<SessionLease[]> {
  const held: SessionLease[] = [];
  const folder = pathOf(source, 'session-leases');
  let names: string[];
  try {
    names = isDir(folder)
      ? listNames(folder).map((name) => pathOf(folder, name)).filter((p) => isFile(p) && suffix(splitName(p)[1]) === '.lock')
        .sort(pathOrder)
      : [];
  } catch (error) {
    throw new MigrationAborted('waiting', `the lease folder cannot be read (${(error as Error).message})`);
  }
  for (const path of names) {
    try {
      held.push(await SessionLease.atPath(path).acquire(false));
    } catch (error) {
      if (!(error instanceof OwnershipConflict)) throw error;
      for (const lease of held) lease.release();
      throw new MigrationAborted(
        'waiting',
        'a conversation lease in the old folder is still held by another process (an agent is running there)',
      );
    }
  }
  return held;
}

export function checkProcesses(source: string): void {
  const hostPid = readPid(pathOf(source, INFO_NAME));
  if (hostPid && pidAlive(hostPid)) {
    throw new MigrationAborted('waiting', `the old agent host (process ${hostPid}) is still running; stop it with --stop-host first`);
  }
  const webPid = readPid(pathOf(source, 'artifact-web.json'));
  if (webPid && webPid !== Deno.pid && pidAlive(webPid)) {
    throw new MigrationAborted('waiting', `the old web server (process ${webPid}) is still running`);
  }
}

// ---- what to copy ------------------------------------------------------------------------------
const isHalfWritten = (name: string) => name.startsWith('.') && name.endsWith('.tmp'); // a half-written temp file of the old process

/** os.walk(top) top-down with dirs and names sorted: [relative posix path, absolute path] of each file. Symlinked folders are not followed. */
function walkFiles(top: string, relative: string, out: [string, string][]): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(top)];
  } catch {
    return; // os.walk ignores folders it cannot list
  }
  const dirs: [string, boolean][] = [];
  const names: string[] = [];
  for (const entry of entries) {
    const full = pathOf(top, entry.name);
    const dir = entry.isDirectory || (entry.isSymlink && isDir(full));
    if (dir) dirs.push([entry.name, entry.isSymlink]);
    else names.push(entry.name);
  }
  for (const item of names.sort(pyCompare)) {
    if (isHalfWritten(item)) continue;
    out.push([relative + '/' + item, pathOf(top, item)]);
  }
  for (const [name, link] of dirs.sort((a, b) => pyCompare(a[0], b[0]))) {
    if (!link) walkFiles(pathOf(top, name), relative + '/' + name, out);
  }
}

/** [[relative path, absolute source path]] to copy, plus the names deliberately left behind. */
export function planFiles(source: string): [[string, string][], string[]] {
  const files: [string, string][] = [];
  const left: string[] = [];
  for (const name of listNames(source).sort(pathOrder)) {
    const entry = pathOf(source, name);
    if (isDir(entry)) {
      if ((COPY_DIRS as readonly string[]).includes(name)) walkFiles(entry, name, files);
      else left.push(name + '/');
      continue;
    }
    if (SKIP_EXACT.has(name) || SKIP_PREFIX.some((p) => name.startsWith(p)) || name === NOTE_NAME || name === MIGRATED_MARKER) continue;
    if (isHalfWritten(name)) continue;
    if (name.startsWith('studio-') || (KEEP_EXACT as readonly string[]).includes(name)) files.push([name, entry]);
    else left.push(name);
  }
  return [files, left];
}

// ---- rewriting absolute references -------------------------------------------------------------
const BS = '\\';
const STYLES: ((p: string) => string)[] = [
  (p) => p,
  (p) => p.replaceAll(BS, '/'),
  (p) => p.replaceAll(BS, BS + BS),
  (p) => p.replaceAll(BS, '/').replaceAll('/', BS + '/'),
];

function reEscape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Replace absolute references to the old folder (plain, forward-slash and JSON-escaped spellings) by the new one. */
export function rewrite(data: Uint8Array, source: string, target: string): [Uint8Array, number] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return [data, 0];
  }
  let count = 0;
  for (const style of STYLES) {
    const oldText = style(String(source));
    const newText = style(String(target));
    text = text.replace(new RegExp(reEscape(oldText), WIN ? 'giu' : 'gu'), () => {
      count++;
      return newText;
    });
  }
  return count ? [new TextEncoder().encode(text), count] : [data, 0];
}

/** json.loads(text) as a validity check; throws JSONDecodeError (Python's message for a BOM, a position-only one otherwise). */
class JSONDecodeError extends Error {
  override name = 'JSONDecodeError';
}

function checkJson(text: string): void {
  const where = (pos: number) => {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    return `line ${line} column ${pos - (before.lastIndexOf('\n') + 1) + 1} (char ${pos})`;
  };
  if (text.startsWith('﻿')) throw new JSONDecodeError(`Unexpected UTF-8 BOM (decode using utf-8-sig): ${where(0)}`);
  try {
    parseJson(text);
  } catch (error) {
    const pos = Number(/at (\d+)$/.exec((error as Error).message)?.[1] ?? 0);
    throw new JSONDecodeError(`Invalid JSON: ${where(pos)}`);
  }
}

// ---- the copy ----------------------------------------------------------------------------------
/** Remove leftover copies of dead migrations next to the target (only folders carrying our mark). */
function cleanStaleTmp(target: string): void {
  const [parent, name] = splitName(target);
  const prefix = name + '.tmp-';
  let candidates: string[];
  try {
    candidates = listNames(parent).filter((n) => n.startsWith(prefix) && isDir(pathOf(parent, n)));
  } catch {
    return;
  }
  for (const folderName of candidates) {
    const folder = pathOf(parent, folderName);
    const tail = folderName.slice(prefix.length);
    if (!exists(pathOf(folder, TMP_MARK))) continue;
    const pid = /^[0-9]+$/.test(tail) ? Number(tail) : null;
    if (pid === Deno.pid || !pidAlive(pid)) rmtreeQuiet(folder);
  }
}

type OnFile = (relative: string) => void;

function copyAll(source: string, target: string, files: [string, string][], onFile: OnFile | undefined, say: Say): [string, string[]] {
  const [parent, name] = splitName(target);
  const tmp = pathOf(parent, `${name}.tmp-${Deno.pid}`);
  if (exists(tmp)) {
    if (!exists(pathOf(tmp, TMP_MARK))) {
      throw new MigrationAborted('failed', `${tmp} exists and is not a leftover of a migration; not touching it`);
    }
    Deno.removeSync(tmp, { recursive: true });
  }
  ensurePrivateDir(tmp, false, say);
  writeText(pathOf(tmp, TMP_MARK), pyJsonDumps({ pid: Deno.pid, source: String(source) }));
  const expected = new Map<string, [number, string, string, string]>();
  const rewritten: string[] = [];
  for (const [relative, path] of files) {
    const data = Deno.readFileSync(path);
    const sourceHash = sha256(data);
    let out: Uint8Array = data;
    if (relative.endsWith('manifest.json') || (!relative.includes('/') && relative.endsWith('.json'))) { // never an artifact's own versions
      const [changed, count] = rewrite(data, source, target);
      out = changed;
      if (count) {
        rewritten.push(relative);
        checkJson(new TextDecoder('utf-8', { ignoreBOM: true }).decode(out)); // still valid JSON
      }
    }
    const destination = pathOf(tmp, ...relative.split('/'));
    Deno.mkdirSync(splitName(destination)[0], { recursive: true });
    Deno.writeFileSync(destination, out);
    const info = Deno.statSync(path);
    if (info.atime && info.mtime) Deno.utimeSync(destination, info.atime, info.mtime);
    expected.set(relative, [out.length, sha256(out), sourceHash, path]);
    if (onFile) onFile(relative);
  }
  // verify the copy, and that the source did not change while we read it
  for (const [relative, [size, digest, sourceHash, path]] of expected) {
    const copied = pathOf(tmp, ...relative.split('/'));
    const info = stat(copied);
    if (!info?.isFile || info.size !== size || shaOf(copied) !== digest) {
      throw new MigrationAborted('failed', `verification failed for ${relative}`);
    }
    if (!rewritten.includes(relative) && digest !== sourceHash) {
      throw new MigrationAborted('failed', `copy of ${relative} differs from the source`);
    }
    if (!isFile(path) || shaOf(path) !== sourceHash) {
      throw new MigrationAborted(
        'waiting',
        `${relative} changed in the old folder while it was being copied (something is still using it)`,
      );
    }
  }
  const present = new Set<string>();
  const collect = (dir: string, prefix: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const full = pathOf(dir, entry.name);
      if (entry.isDirectory) collect(full, prefix + entry.name + '/');
      else if (isFile(full)) present.add(prefix + entry.name);
    }
  };
  collect(tmp, '');
  present.delete(TMP_MARK);
  if (present.size !== expected.size || [...present].some((p) => !expected.has(p))) {
    throw new MigrationAborted('failed', 'the copy holds files that were not planned');
  }
  return [tmp, rewritten];
}

/** time.strftime('%Y-%m-%d %H:%M:%S %z') */
function strftimeLocal(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${sign}${two(Math.floor(abs / 60))}${two(abs % 60)}`;
}

/** json.dumps(value, indent=1) (ensure_ascii, Python's float spelling for `at`). */
function recordJson(record: Record<string, unknown>): string {
  let text = JSON.stringify(record, null, 1).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (Number.isInteger(record.at)) text = text.replace(/^ "at": (-?\d+),$/m, ' "at": $1.0,');
  return text;
}

export interface MigrateOptions {
  /** Progress lines; prints to stdout when omitted. */
  say?: Say;
  /** Called after each file is copied (tests use it to simulate a kill: throw MigrationKilled). */
  onFile?: OnFile;
}

/**
 * Move source's data into target. Returns {state: 'done'|'waiting'|'blocked'|'failed'|'none', reason, source, ...}; never throws
 * for an expected condition.
 */
export async function migrate(source: string, target: string, options: MigrateOptions = {}): Promise<Migration> {
  const say: Say = options.say ?? ((message) => console.log(message));
  source = pathOf(String(source));
  target = pathOf(String(target));
  if (!isDir(source)) return result('none', 'nothing to migrate', source);
  if (exists(pathOf(target, MIGRATED_MARKER))) return result('done', 'already migrated', source);
  if (exists(target) && listNames(target).length) {
    return result(
      'blocked',
      `${target} already holds files but was never marked as migrated; move it aside to let Agent Studio migrate`,
      source,
    );
  }
  let held: SessionLease[] = [];
  let files: [string, string][] = [];
  let rewritten: string[] = [];
  let record: Record<string, unknown> = {};
  try {
    checkProcesses(source);
    held = await acquireAllLeases(source);
    let left: string[];
    [files, left] = planFiles(source);
    cleanStaleTmp(target);
    say(`Moving Agent Studio data from ${source} to ${target} (${files.length} files)...`);
    let tmp: string;
    [tmp, rewritten] = copyAll(source, target, files, options.onFile, say);
    const at = (performance.timeOrigin + performance.now()) / 1000; // time.time(), below the millisecond too
    record = {
      version: 1,
      source: String(source),
      at,
      atText: strftimeLocal(new Date(at * 1000)),
      files: files.length,
      rewrittenPaths: rewritten,
      notCopied: left,
    };
    writeText(pathOf(tmp, MIGRATED_MARKER), recordJson(record));
    Deno.removeSync(pathOf(tmp, TMP_MARK));
    if (exists(target)) Deno.removeSync(target); // an empty folder (checked above); a rename onto it fails on Windows
    try {
      Deno.renameSync(tmp, target);
    } catch (error) {
      if (exists(pathOf(target, MIGRATED_MARKER))) { // a second Studio finished first
        rmtreeQuiet(tmp);
        return result('done', 'already migrated', source);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof MigrationKilled) throw error;
    if (error instanceof MigrationAborted) return result(error.state, error.reason, source);
    log.exception(error, 'Data migration from %s failed', source);
    return result('failed', `${pyErrorName(error)}: ${error instanceof Error ? error.message : String(error)}`, source);
  } finally {
    for (const lease of held) lease.release();
  }
  try { // the only change ever made to the old folder
    writeText(
      pathOf(source, NOTE_NAME),
      `Agent Studio moved this folder's data to:\n  ${target}\non ${record.atText}.\n\n` +
        'Nothing in this folder was changed or deleted; it is kept as a backup and is no longer used.\n' +
        `To go back to it (rollback), start Agent Studio with: --state-dir "${source}"\n`,
    );
  } catch (error) {
    say(`Note: could not write ${NOTE_NAME} in ${source}: ${(error as Error).message}`);
  }
  say(`Agent Studio data moved to ${target}.`);
  return result('done', '', source, { files: files.length, rewrittenPaths: rewritten });
}

registerMigrate((source, target, say) => migrate(source, target, { say }));

if (import.meta.main) {
  const [source, target] = Deno.args;
  if (!source || !target || Deno.args.length !== 2) {
    console.error('usage: migrate.ts SOURCE TARGET');
    Deno.exit(2);
  }
  const outcome = await migrate(source, target);
  console.log(JSON.stringify(outcome, null, 1));
  Deno.exit(['done', 'none'].includes(outcome.state) ? 0 : 2);
}
