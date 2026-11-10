/**
 * Runs after AIB has quit: waits for the app process to exit, checks the downloaded package's SHA-256 once more, unpacks it and swaps
 * the new files in place, then starts the new AIB. Started detached by updater.ts as `<AIB binary> update-helper <json>` (desktop app)
 * or `deno run -A update_helper.ts <json>` (dev), with one JSON argument: {installer, sha256, pid, exe, log, version, kind, target}.
 * Writes a short log (the `log` path, install.log next to state.json).
 *
 * The swap, per kind (the packages tools/build.ts makes):
 *   windows-zip  target = the install folder (the one with AIB.exe). The zip is unpacked with Windows' own tar.exe into
 *                <target>\.aib-update-<stamp>\ and each top-level file or folder of its AIB\ folder replaces the one of the same
 *                name: the old one is renamed to <name>.old-<stamp> (Windows allows renaming a running exe or dll, so an agent host
 *                still running from the old files keeps running), then the new one is moved in. AIB.exe.WebView2\ (the page's local
 *                storage) is never touched.
 *   macos-zip    target = the AIB.app bundle. Unpacked with `ditto -x -k` beside it; the bundle is renamed to AIB.app.old-<stamp>
 *                and the new one moved in.
 *   appimage     target = the AppImage file ($APPIMAGE). The new file is copied beside it, made executable, and renamed over it
 *                (the old one becomes <name>.old-<stamp>). The updater starts this helper from the new AppImage, so the old one's
 *                mount can go away.
 * If any rename fails, or the new app cannot start (it cannot be spawned or exits with an error within STARTUP_SECONDS), every rename
 * is undone and the old app is started again. Leftovers (*.old-*, .aib-update-*) are deleted by the new app at startup:
 * removeUpdateLeftovers().
 *
 * Exit codes: 0 updated and started; 1 bad arguments; 2 the app did not quit; 3 package unreadable; 4 checksum changed; 5 could not
 * unpack (or the package has no app in it); 6 could not swap (rolled back); 7 the new app could not start (rolled back).
 */
import { createHash } from 'node:crypto';
import { processAlive } from '../platform/process_info.ts';
import { spawnDetached } from '../platform/spawn_detached.ts';
import { ensureHiddenConsole } from '../platform/console.ts';
import { isDesktopApp } from '../core/app.ts';

export const WAIT_FOR_APP_SECONDS = 90;
export const UNPACK_TIMEOUT_SECONDS = 600;
/** The new app counts as started when it is still running (or exited with 0) this long after the spawn. */
export const STARTUP_SECONDS = 8;
/** Never moved or replaced in the Windows install folder: WebView2's profile (localStorage) for AIB.exe. */
export const KEEP = /\.WebView2$/i;
export const LEFTOVER = /\.old-\d{8}-\d{6}(-\d+)?$/;
export const STAGE_PREFIX = '.aib-update-';

export type UpdateKind = 'windows-zip' | 'macos-zip' | 'appimage';

export interface HelperArgs {
  /** The downloaded, verified package (zip or AppImage). */
  installer: string;
  sha256: string;
  /** The app process to wait for. */
  pid: number;
  /** The app's executable (Deno.execPath() of the old app); the new one has the same path after the swap. */
  exe: string;
  log: string;
  version: string;
  kind: UpdateKind;
  /** What is replaced: the install folder (Windows), the .app bundle (macOS), the AppImage file (Linux). */
  target: string;
}

export interface StartResult {
  /** Exit code when the process ended within the startup window; null while it still runs. */
  code: number | null;
}

export interface HelperDeps {
  /** Is the old app still running? */
  alive?: (pid: number) => boolean;
  sleep?: (seconds: number) => void | Promise<void>;
  /** Unpack the archive into dest (a new, empty folder). Throws on failure. */
  unpack?: (archive: string, dest: string, kind: UpdateKind) => Promise<void>;
  /** Start the app detached and hidden; resolve once it has exited or STARTUP_SECONDS passed. Throws when it cannot start. */
  start?: (command: string[], env: Record<string, string>) => Promise<StartResult>;
  /** The <stamp> in .old-<stamp> (tests pin it). */
  stamp?: string;
}

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const join = (...parts: string[]) =>
  parts.map((p, i) => (i ? p.replace(/^[\\/]+/, '') : p)).map((p, i, a) => (i < a.length - 1 ? p.replace(/[\\/]+$/, '') : p)).join(SEP);
const dirname = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || SEP;
const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function stampNow(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function log(path: string | undefined, text: string): void {
  if (!path) return;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${
    pad(d.getSeconds())
  } `;
  try {
    Deno.writeTextFileSync(path, stamp + text + '\n', { append: true });
  } catch { /* not fatal */ }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  using file = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(1 << 20);
  for (;;) {
    const n = await file.read(buffer);
    if (n === null) break;
    hash.update(buffer.subarray(0, n));
  }
  return hash.digest('hex');
}

/** True while the process runs. Windows: kernel32 (unknown counts as gone). POSIX: `kill -0`. */
export function defaultAlive(pid: number): boolean {
  if (Deno.build.os === 'windows') return processAlive(pid) === true;
  try {
    return new Deno.Command('kill', { args: ['-0', String(pid)], stdout: 'null', stderr: 'null' }).outputSync().success;
  } catch {
    return false;
  }
}

/** The new app must not inherit the old one's launch variables (nor an AppImage runtime's, nor deno desktop's serve address). */
export function cleanEnv(env: Record<string, string> = Deno.env.toObject()): Record<string, string> {
  const drop = new Set(['PYTHONHOME', 'AGENT_STUDIO_LAUNCH_NONCE', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'DENO_SERVE_ADDRESS']);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k) && !k.startsWith('AIB_')));
}

async function runQuiet(command: string, args: string[], timeoutSeconds: number): Promise<void> {
  const child = new Deno.Command(command, { args, stdin: 'null', stdout: 'null', stderr: 'piped' }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch { /* gone */ }
  }, timeoutSeconds * 1000);
  try {
    const out = await child.output();
    if (!out.success) {
      throw new Error(`${basename(command)} failed (${out.code}): ${new TextDecoder().decode(out.stderr).trim().slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Windows: System32\tar.exe (bsdtar) reads zips. macOS: ditto keeps modes, symlinks and signatures. */
export async function defaultUnpack(archive: string, dest: string, kind: UpdateKind): Promise<void> {
  if (kind === 'windows-zip') {
    const root = Deno.env.get('SystemRoot') || 'C:\\Windows';
    await runQuiet(`${root}\\System32\\tar.exe`, ['-xf', archive, '-C', dest], UNPACK_TIMEOUT_SECONDS);
  } else if (kind === 'macos-zip') {
    await runQuiet('/usr/bin/ditto', ['-x', '-k', archive, dest], UNPACK_TIMEOUT_SECONDS);
  } else {
    throw new Error('nothing to unpack for ' + kind);
  }
}

/** Start detached with no console (platform/spawn_detached), then watch it for STARTUP_SECONDS. */
export async function defaultStart(
  command: string[],
  env: Record<string, string>,
  sleep: (seconds: number) => void | Promise<void> = sleepFor,
): Promise<StartResult> {
  const temp = env.TEMP || env.TMPDIR || env.TMP || (Deno.build.os === 'windows' ? 'C:\\Windows\\Temp' : '/tmp');
  const child = await spawnDetached(command, join(temp, 'aib-update-start.log'), dirname(command[0]), env);
  try {
    for (let waited = 0; waited < STARTUP_SECONDS; waited += 0.25) {
      const code = child.exitCode();
      if (code !== null) return { code };
      await sleep(0.25);
    }
    return { code: child.exitCode() };
  } finally {
    child.close();
  }
}

const sleepFor = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** One undoable step: `moved` (the old file, now at aside) and `placed` (the new file, now at path). */
export interface SwapStep {
  path: string;
  aside: string | null;
  placed: boolean;
  from: string;
}

/** Put `replacement` at `path`, the old one aside as <path>.old-<stamp>. Appends to journal before each rename. */
function swapOne(path: string, replacement: string, stamp: string, journal: SwapStep[]): void {
  const step: SwapStep = { path, aside: null, placed: false, from: replacement };
  journal.push(step);
  if (exists(path)) {
    const aside = `${path}.old-${stamp}`;
    Deno.renameSync(path, aside);
    step.aside = aside;
  }
  Deno.renameSync(replacement, path);
  step.placed = true;
}

/** Windows: each top-level entry of newDir replaces the one of the same name in installDir; the WebView2 folder is never touched. */
export function swapFolder(installDir: string, newDir: string, stamp: string, journal: SwapStep[] = []): SwapStep[] {
  const names = [...Deno.readDirSync(newDir)].map((e) => e.name).filter((n) => !KEEP.test(n)).sort();
  for (const name of names) swapOne(join(installDir, name), join(newDir, name), stamp, journal);
  return journal;
}

/** macOS bundle or Linux AppImage: the one path is replaced. */
export function swapPath(target: string, replacement: string, stamp: string, journal: SwapStep[] = []): SwapStep[] {
  swapOne(target, replacement, stamp, journal);
  return journal;
}

/** Undo a (possibly partial) swap, newest step first. Returns the paths it could not restore. */
export function rollback(journal: SwapStep[], stamp: string): string[] {
  const failed: string[] = [];
  for (const step of [...journal].reverse()) {
    try {
      if (step.placed) {
        // The new one goes back where it came from (or aside, if that is gone), then the old one returns.
        try {
          Deno.renameSync(step.path, step.from);
        } catch {
          Deno.renameSync(step.path, `${step.path}.failed-${stamp}`);
        }
      }
      if (step.aside) Deno.renameSync(step.aside, step.path);
    } catch {
      failed.push(step.path);
    }
  }
  return failed;
}

function findApp(stage: string, kind: UpdateKind, exeName: string): string | null {
  const dirs = [...Deno.readDirSync(stage)].filter((e) => e.isDirectory).map((e) => e.name);
  if (kind === 'windows-zip') {
    for (const d of dirs) if (exists(join(stage, d, exeName))) return join(stage, d);
    return null;
  }
  for (const d of dirs) if (d.endsWith('.app') && exists(join(stage, d, 'Contents', 'MacOS', exeName))) return join(stage, d);
  return null;
}

/** Resolves to 0 when the new version was swapped in and started, else a non-zero code (the old install is put back). */
export async function run(args: Partial<HelperArgs> | Record<string, unknown>, deps: HelperDeps = {}): Promise<number> {
  const alive = deps.alive ?? defaultAlive;
  const sleep = deps.sleep ?? sleepFor;
  const unpack = deps.unpack ?? defaultUnpack;
  const start = deps.start ?? ((command, env) => defaultStart(command, env, sleep));
  const stamp = deps.stamp ?? stampNow();
  const note = typeof args.log === 'string' && args.log ? args.log : undefined;
  const installer = String(args.installer ?? '');
  const want = String(args.sha256 || '').toLowerCase();
  const pid = args.pid;
  const exe = String(args.exe ?? '');
  const kind = args.kind as UpdateKind;
  const target = String(args.target ?? '');
  if (!['windows-zip', 'macos-zip', 'appimage'].includes(kind) || !target || !exe) {
    log(note, `update to ${args.version ?? 'None'}: missing or unknown kind, target or exe; nothing was changed`);
    return 1;
  }
  log(note, `update to ${args.version ?? 'None'}: waiting for the app (pid ${pid ?? 'None'}) to quit`);
  let waited = 0;
  while (pid && alive(Number(pid))) {
    if (waited >= WAIT_FOR_APP_SECONDS) {
      log(note, 'the app did not quit; nothing was installed');
      return 2;
    }
    await sleep(0.5);
    waited += 0.5;
  }
  let have: string;
  try {
    have = await sha256(installer);
  } catch (error) {
    log(note, `cannot read the update: ${error instanceof Error ? error.message : error}`);
    return 3;
  }
  if (have !== want) {
    log(note, 'the update does not match its verified checksum; nothing was changed');
    return 4;
  }

  // Unpack next to what it replaces (same volume, so the swap is renames only).
  const stage = kind === 'windows-zip' ? join(target, STAGE_PREFIX + stamp) : join(dirname(target), STAGE_PREFIX + stamp);
  let replacement: string;
  try {
    Deno.mkdirSync(stage, { recursive: true });
    if (kind === 'appimage') {
      replacement = join(stage, basename(target));
      Deno.copyFileSync(installer, replacement);
      if (Deno.build.os !== 'windows') Deno.chmodSync(replacement, 0o755);
    } else {
      await unpack(installer, stage, kind);
      const found = findApp(stage, kind, basename(exe));
      if (!found) throw new Error(`the package has no ${kind === 'windows-zip' ? basename(exe) : '.app with ' + basename(exe)}`);
      replacement = found;
    }
  } catch (error) {
    log(note, `could not unpack the update: ${error instanceof Error ? error.message : error}`);
    try {
      Deno.removeSync(stage, { recursive: true });
    } catch { /* leftover; cleaned at the next start */ }
    return 5;
  }

  const journal: SwapStep[] = [];
  const dropStage = () => {
    try {
      Deno.removeSync(stage, { recursive: true });
    } catch { /* leftover; removeUpdateLeftovers() deletes it at the next start */ }
  };
  // The new files go back into the unpack folder on a rollback, so it stays until the new app has started.
  const restore = (why: string) => {
    const failed = rollback(journal, stamp);
    dropStage();
    log(note, failed.length ? `${why}; could NOT restore: ${failed.join(', ')}` : `${why}; the old version was put back`);
  };
  try {
    if (kind === 'windows-zip') swapFolder(target, replacement, stamp, journal);
    else swapPath(target, replacement, stamp, journal);
  } catch (error) {
    restore(`could not swap the files (${error instanceof Error ? error.message : error})`);
    return 6;
  }

  const command = kind === 'appimage' ? [target] : [exe];
  log(note, `swapped in ${args.version ?? 'the new version'}; starting it`);
  let started: StartResult | null = null;
  let why = '';
  try {
    started = await start(command, cleanEnv());
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  if (started && (started.code === null || started.code === 0)) {
    dropStage();
    log(note, 'the new version is running');
    return 0;
  }
  restore(`the new version could not start (${started ? `exit code ${started.code}` : why})`);
  try {
    await start(command, cleanEnv()); // the old version again
  } catch { /* the person starts it by hand */ }
  return 7;
}

// ---- where the app is installed, and the cleanup the new app runs at startup ------------------------------------------

export interface InstallTarget {
  kind: UpdateKind;
  target: string;
}

/**
 * What an in-place update replaces for the running app, or null when it cannot update itself. Inside a `deno desktop` binary
 * Deno.execPath() is the launcher itself (checked on Windows: <install folder>\AIB.exe, also for subcommands), so: Windows = its
 * folder; macOS = the bundle three levels above Contents/MacOS/<exe>; Linux = $APPIMAGE (a .deb install updates by hand).
 */
export function installTarget(
  os: string = Deno.build.os,
  exe: string = Deno.execPath(),
  env: Record<string, string | undefined> = Deno.env.toObject(),
): InstallTarget | null {
  if (os === 'windows') return exe ? { kind: 'windows-zip', target: exe.replace(/[\\/][^\\/]*$/, '') } : null;
  if (os === 'darwin' || os === 'macos') {
    const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
    return m ? { kind: 'macos-zip', target: m[1] } : null;
  }
  if (os === 'linux') return env.APPIMAGE ? { kind: 'appimage', target: env.APPIMAGE } : null;
  return null;
}

/**
 * Delete what an update left behind: *.old-<stamp> files and folders and .aib-update-* folders. Called by the new app at startup
 * (main.ts). Windows: a stamp's files are deleted only once its old .exe can be deleted, i.e. no process (an agent host still on the
 * old version, or the helper itself) runs from them; otherwise that stamp waits for the next start. Returns the paths removed. A
 * no-op outside the desktop app unless `target` is given (tests).
 */
export function removeUpdateLeftovers(options: { target?: InstallTarget | null; desktop?: boolean } = {}): string[] {
  const removed: string[] = [];
  try {
    if (!(options.desktop ?? isDesktopApp()) && !options.target) return removed;
    const t = options.target !== undefined ? options.target : installTarget();
    if (!t) return removed;
    const folder = t.kind === 'windows-zip' ? t.target : dirname(t.target);
    const prefix = t.kind === 'windows-zip' ? '' : basename(t.target) + '.old-';
    const remove = (p: string): boolean => {
      try {
        Deno.removeSync(p, { recursive: true });
        removed.push(p);
        return true;
      } catch {
        return false;
      }
    };
    const groups = new Map<string, string[]>();
    for (const e of Deno.readDirSync(folder)) {
      if (e.name.startsWith(STAGE_PREFIX)) {
        remove(join(folder, e.name));
        continue;
      }
      const m = LEFTOVER.exec(e.name);
      if (!m || !e.name.startsWith(prefix) || KEEP.test(e.name)) continue;
      const stamp = m[0];
      groups.set(stamp, [...(groups.get(stamp) ?? []), join(folder, e.name)]);
    }
    for (const paths of groups.values()) {
      // Executables first: if one is still running it cannot be deleted, and the rest of its version stays with it.
      const exes = paths.filter((p) => /\.exe\.old-/i.test(p));
      if (!exes.every(remove)) continue;
      for (const p of paths) if (!exes.includes(p)) remove(p);
    }
  } catch { /* never stops the app from starting */ }
  return removed;
}

/** `AIB update-helper <json>` (main.ts) and `deno run update_helper.ts <json>` (dev). */
export async function main(argv: string[]): Promise<number> {
  ensureHiddenConsole(); // tar.exe and the restart must not flash a console window (main.ts dispatches before its own call)
  let parsed: unknown;
  try {
    parsed = JSON.parse(argv[0]);
  } catch {
    return 1;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 1;
  return await run(parsed as Record<string, unknown>);
}

if (import.meta.main) Deno.exit(await main(Deno.args));
