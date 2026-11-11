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
 * If any rename fails, or the new app does not confirm its start (it writes the `marker` file, <data>/updates/started-<ver>.ok,
 * once its window has loaded the page, or once a `serve` listens; MARKER_SECONDS at most) or exits with an error first, every
 * rename is undone and the old app is started again. Without a marker (older callers) "still running after STARTUP_SECONDS"
 * counts as started. Each rename is recorded in `journal` (install-journal.json next to the log) BEFORE it happens, so an update
 * cut off in the middle (power loss, the helper killed) is undone by the next AIB start: recoverInterruptedUpdate(). While it
 * works the helper shows a tray icon "Updating AIB to <ver>..." (it never runs invisibly). Leftovers (*.old-*, .aib-update-*)
 * are deleted by the new app at startup: removeUpdateLeftovers().
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
/** How long the helper waits for the new app's "page loaded" marker. */
export const MARKER_SECONDS = 60;
export const JOURNAL_NAME = 'install-journal.json';
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
  /** The arguments the old app was started with (`serve --port N`, `--state-dir D`, ...): the new one starts with the same. */
  args?: string[];
  /** The file the new app writes once it is up (<data>/updates/started-<ver>.ok): the only proof of a good start. */
  marker?: string;
  /**
   * The data folder whose keeper holds the chats the old app left running (Install now with AIB_KEEPER=1). The helper stays connected
   * to that keeper from before the old app quits until the new version (or, after a rollback, the old one again) has started, so the
   * keeper always has a client and never runs its orphan command (which would start AIB from a half-swapped folder).
   */
  keeper?: string;
}

export interface StartResult {
  /** Exit code when the process ended within the startup window; null while it still runs. */
  code: number | null;
  /** With a marker: true once the new app wrote it. */
  confirmed?: boolean;
}

export interface HelperDeps {
  /** Is the old app still running? */
  alive?: (pid: number) => boolean;
  sleep?: (seconds: number) => void | Promise<void>;
  /** Unpack the archive into dest (a new, empty folder). Throws on failure. */
  unpack?: (archive: string, dest: string, kind: UpdateKind) => Promise<void>;
  /**
   * Start the app detached and hidden; resolve once it confirmed (marker), exited with an error, or the wait ran out. Throws when it
   * cannot start.
   */
  start?: (command: string[], env: Record<string, string>, marker?: string) => Promise<StartResult>;
  /** The helper's tray icon (tests: a fake). Returns a close function. */
  tray?: (tooltip: string) => () => void;
  /** The <stamp> in .old-<stamp> (tests pin it). */
  stamp?: string;
  /** Connect to the keeper of a data folder and stay connected; resolves to a description and the function that disconnects. */
  keepKeeper?: (dataDir: string) => Promise<{ what: string; release: () => void } | null>;
}

/** Stay connected to the keeper of `dataDir` (an authenticated connection counts as its client). null when none runs. */
export async function defaultKeepKeeper(dataDir: string): Promise<{ what: string; release: () => void } | null> {
  const { findKeeper } = await import('../keeper/client.ts');
  const client = await findKeeper(dataDir);
  if (!client) return null;
  let live = 0;
  try {
    live = (await client.list()).filter((c) => c.live).length;
  } catch { /* still connected: that is what counts */ }
  return { what: `keeper ${client.keeperVersion} (pid ${client.keeperPid}, ${live} running agent(s))`, release: () => client.close() };
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

/** AIB_ variables the new app keeps: the keeper switch (the new version must take the chats over in the same mode), a test's tray file. */
const KEEP_ENV = new Set(['AIB_KEEPER', 'AIB_TEST_TRAY_STATE']);

/** The new app must not inherit the old one's launch variables (nor an AppImage runtime's, nor deno desktop's serve address). */
export function cleanEnv(env: Record<string, string> = Deno.env.toObject()): Record<string, string> {
  const drop = new Set(['PYTHONHOME', 'AGENT_STUDIO_LAUNCH_NONCE', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'DENO_SERVE_ADDRESS']);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k) && (!k.startsWith('AIB_') || KEEP_ENV.has(k))));
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

/**
 * Start detached with no console (platform/spawn_detached), then watch it: with a marker, until the marker appears (confirmed), the
 * app exits with an error, or MARKER_SECONDS pass; without one, for STARTUP_SECONDS.
 */
export async function defaultStart(
  command: string[],
  env: Record<string, string>,
  sleep: (seconds: number) => void | Promise<void> = sleepFor,
  marker?: string,
): Promise<StartResult> {
  const temp = env.TEMP || env.TMPDIR || env.TMP || (Deno.build.os === 'windows' ? 'C:\\Windows\\Temp' : '/tmp');
  const child = await spawnDetached(command, join(temp, 'aib-update-start.log'), dirname(command[0]), env);
  try {
    const limit = marker ? MARKER_SECONDS : STARTUP_SECONDS;
    for (let waited = 0; waited < limit; waited += 0.25) {
      if (marker && exists(marker)) return { code: child.exitCode(), confirmed: true };
      const code = child.exitCode();
      if (code !== null && (!marker || code !== 0)) return { code };
      await sleep(0.25);
    }
    return marker ? { code: child.exitCode(), confirmed: exists(marker) } : { code: child.exitCode() };
  } finally {
    child.close();
  }
}

/** The helper's tray icon: "Updating AIB to <ver>..." for its whole life. Never throws; returns the function that removes it. */
export function helperTray(tooltip: string): () => void {
  let close = () => {};
  let closed = false;
  void (async () => {
    try {
      const { writeTrayState } = await import('./host_tray.ts');
      writeTrayState('helper', { shown: true, tooltip });
      const prev = close;
      close = () => {
        prev();
        writeTrayState('helper', { shown: false, tooltip });
      };
      const { trayIconPng } = await import('./tray_icon.ts');
      if (Deno.build.os === 'windows') {
        const { startWindowsTray } = await import('./tray_win.ts');
        const t = await startWindowsTray(trayIconPng(), tooltip, [], () => {}, () => {});
        if (t && closed) t.remove();
        else if (t) {
          const prev2 = close;
          close = () => {
            prev2();
            t.remove();
          };
        }
        return;
      }
      // deno-lint-ignore no-explicit-any
      const D = Deno as any;
      if (typeof D.Tray !== 'function') return;
      const tray = new D.Tray();
      tray.setIcon(trayIconPng());
      tray.setTooltip(tooltip);
      const prev3 = close;
      close = () => {
        prev3();
        try {
          tray.destroy?.();
        } catch { /* gone */ }
      };
      if (closed) close();
    } catch { /* no tray here: the helper is short-lived anyway */ }
  })();
  return () => {
    closed = true;
    close();
  };
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

/** Called before every rename with the journal as it will be after it: install-journal.json is written then (crash safety). */
export type Persist = (journal: SwapStep[]) => void;

/** Put `replacement` at `path`, the old one aside as <path>.old-<stamp>. Appends to journal (and persists it) before each rename. */
function swapOne(path: string, replacement: string, stamp: string, journal: SwapStep[], persist: Persist = () => {}): void {
  const step: SwapStep = { path, aside: null, placed: false, from: replacement };
  journal.push(step);
  if (exists(path)) {
    const aside = `${path}.old-${stamp}`;
    step.aside = aside;
    persist(journal);
    Deno.renameSync(path, aside);
  }
  step.placed = true;
  persist(journal);
  Deno.renameSync(replacement, path);
}

/** Windows: each top-level entry of newDir replaces the one of the same name in installDir; the WebView2 folder is never touched. */
export function swapFolder(installDir: string, newDir: string, stamp: string, journal: SwapStep[] = [], persist?: Persist): SwapStep[] {
  const names = [...Deno.readDirSync(newDir)].map((e) => e.name).filter((n) => !KEEP.test(n)).sort();
  for (const name of names) swapOne(join(installDir, name), join(newDir, name), stamp, journal, persist);
  return journal;
}

/** macOS bundle or Linux AppImage: the one path is replaced. */
export function swapPath(target: string, replacement: string, stamp: string, journal: SwapStep[] = [], persist?: Persist): SwapStep[] {
  swapOne(target, replacement, stamp, journal, persist);
  return journal;
}

/** Undo a (possibly partial) swap, newest step first. Returns the paths it could not restore. */
export function rollback(journal: SwapStep[], stamp: string): string[] {
  const failed: string[] = [];
  for (const step of [...journal].reverse()) {
    try {
      // A step is persisted just BEFORE its rename, so after a crash the last one may not have happened: check the files.
      if (step.placed && exists(step.from)) step.placed = false; // the new file never left the unpack folder
      if (step.aside && !exists(step.aside)) step.aside = null; // the old file was never moved aside
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
  const start = deps.start ?? ((command, env, marker) => defaultStart(command, env, sleep, marker));
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
  const closeTray = (deps.tray ?? (deps.start ? () => () => {} : helperTray))(`Updating AIB to ${args.version ?? 'a new version'}...`);
  // First of all (the old app quits right after starting this helper): keep its keeper company until a version has started again.
  let keeper: { what: string; release: () => void } | null = null;
  if (typeof args.keeper === 'string' && args.keeper) {
    try {
      keeper = await (deps.keepKeeper ?? defaultKeepKeeper)(args.keeper);
      log(note, keeper ? `staying connected to the ${keeper.what} until AIB has started again` : 'no keeper runs; nothing to hold');
    } catch (error) {
      log(note, `could not connect to the keeper (${error instanceof Error ? error.message : error}); its own restart rule applies`);
    }
  }
  try {
    return await runSteps(args, deps, { alive, sleep, unpack, start, stamp, note, installer, want, pid, exe, kind, target });
  } finally {
    if (keeper) {
      keeper.release();
      log(note, 'disconnected from the keeper');
    }
    closeTray();
  }
}

interface Steps {
  alive: (pid: number) => boolean;
  sleep: (seconds: number) => void | Promise<void>;
  unpack: (archive: string, dest: string, kind: UpdateKind) => Promise<void>;
  start: (command: string[], env: Record<string, string>, marker?: string) => Promise<StartResult>;
  stamp: string;
  note: string | undefined;
  installer: string;
  want: string;
  pid: unknown;
  exe: string;
  kind: UpdateKind;
  target: string;
}

async function runSteps(args: Partial<HelperArgs> | Record<string, unknown>, _deps: HelperDeps, c: Steps): Promise<number> {
  const { alive, sleep, unpack, start, stamp, note, installer, want, pid, exe, kind, target } = c;
  const journalPath = note ? join(dirname(note), JOURNAL_NAME) : null;
  const persist: Persist = (journal) => {
    if (!journalPath) return;
    const data = JSON.stringify({ format: 1, helperPid: Deno.pid, version: args.version ?? null, stamp, kind, target, exe, steps: journal });
    Deno.writeTextFileSync(`${journalPath}.tmp`, data);
    Deno.renameSync(`${journalPath}.tmp`, journalPath);
  };
  const dropJournal = () => {
    if (!journalPath) return;
    try {
      Deno.removeSync(journalPath);
    } catch { /* none */ }
  };
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
  log(note, 'the app has quit; unpacking');

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
    if (!failed.length) dropJournal();
    log(note, failed.length ? `${why}; could NOT restore: ${failed.join(', ')}` : `${why}; the old version was put back`);
  };
  try {
    if (kind === 'windows-zip') swapFolder(target, replacement, stamp, journal, persist);
    else swapPath(target, replacement, stamp, journal, persist);
  } catch (error) {
    restore(`could not swap the files (${error instanceof Error ? error.message : error})`);
    return 6;
  }

  const extra = Array.isArray(args.args) ? (args.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const command = [kind === 'appimage' ? target : exe, ...extra];
  const marker = typeof args.marker === 'string' && args.marker ? args.marker : undefined;
  if (marker) {
    try {
      Deno.removeSync(marker);
    } catch { /* none yet */ }
  }
  log(note, `swapped in ${args.version ?? 'the new version'}; starting it${marker ? ' and waiting for it to confirm its start' : ''}`);
  let started: StartResult | null = null;
  let why = '';
  try {
    started = await start(command, cleanEnv(), marker);
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  const ok = started && (marker ? started.confirmed === true : started.code === null || started.code === 0);
  if (ok) {
    dropStage();
    dropJournal();
    log(note, marker ? 'the new version is running (it confirmed its start)' : 'the new version is running');
    return 0;
  }
  restore(
    `the new version could not start (${
      started ? (marker && !started.confirmed && started.code === null ? `no start confirmation within ${MARKER_SECONDS} s` : `exit code ${started.code}`) : why
    })`,
  );
  try {
    await start(command, cleanEnv()); // the old version again
  } catch { /* the person starts it by hand */ }
  return 7;
}

/**
 * At AIB start: an update cut off in the middle of its swap (the helper died, power loss) left install-journal.json. When its helper
 * is gone, undo every recorded rename (the old version comes back whole) and return true: the caller then starts AIB again, since
 * this process may have been started from a half-swapped folder. False when there was nothing to undo. Never throws.
 */
export function recoverInterruptedUpdate(updatesDir: string, alive: (pid: number) => boolean = defaultAlive): boolean {
  const path = join(updatesDir, JOURNAL_NAME);
  const logPath = join(updatesDir, 'install.log');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(Deno.readTextFileSync(path));
  } catch {
    return false;
  }
  try {
    if (typeof data.helperPid === 'number' && data.helperPid !== Deno.pid && alive(data.helperPid)) return false; // still at work
    const steps = Array.isArray(data.steps) ? data.steps as SwapStep[] : [];
    const failed = rollback(steps, String(data.stamp ?? stampNow()));
    if (data.kind === 'windows-zip' && typeof data.target === 'string' && typeof data.stamp === 'string') {
      try {
        Deno.removeSync(join(data.target, STAGE_PREFIX + data.stamp), { recursive: true });
      } catch { /* removeUpdateLeftovers gets it later */ }
    }
    log(
      logPath,
      failed.length
        ? `an interrupted update to ${data.version ?? '?'} was found at start; could NOT restore: ${failed.join(', ')}`
        : `an interrupted update to ${data.version ?? '?'} was found at start; the previous version was put back`,
    );
    Deno.removeSync(path);
    return steps.length > 0;
  } catch {
    return false;
  }
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
export function removeUpdateLeftovers(
  options: { target?: InstallTarget | null; desktop?: boolean; os?: string; processes?: () => string[] | null } = {},
): string[] {
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
    // macOS: deleting a bundle never fails while a process runs from it, so look first (an agent host left on the old version).
    const os = options.os ?? Deno.build.os;
    const running = os === 'darwin' ? (options.processes ?? runningExecutables)() : [];
    for (const paths of groups.values()) {
      const slash = (x: string) => x.replaceAll(String.fromCharCode(92), '/');
      if (running === null || running.some((exe) => paths.some((p) => slash(exe).startsWith(slash(p) + '/')))) continue;
      // Executables first: if one is still running it cannot be deleted, and the rest of its version stays with it.
      const exes = paths.filter((p) => /\.exe\.old-/i.test(p));
      if (!exes.every(remove)) continue;
      for (const p of paths) if (!exes.includes(p)) remove(p);
    }
  } catch { /* never stops the app from starting */ }
  return removed;
}

/** macOS: the full executable path of every running process (`ps -axo comm=`), or null when unknown (then nothing is deleted). */
export function runningExecutables(): string[] | null {
  try {
    const out = new Deno.Command('/bin/ps', { args: ['-axo', 'comm='], stdout: 'piped', stderr: 'null' }).outputSync();
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
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
