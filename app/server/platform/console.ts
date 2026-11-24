/**
 * Windows: give this process a console with no window, so the console programs it starts (agents, git, npm) inherit it instead of
 * each getting a new visible console window. Needed because a windowless parent (a desktop app, `deno compile --no-terminal`, or
 * the agent host, which the web server starts DETACHED_PROCESS) has no console, and Deno.Command cannot pass CREATE_NO_WINDOW.
 * Spike results: measured during the Deno rewrite (Windows 11 24H2+).
 *
 * In order, stopping at the first that works:
 *   1. AllocConsoleWithOptions(NO_WINDOW)  Windows 11 24H2 (build 26100) and later: a console that never has a window.
 *   2. attach to a windowless console      older Windows: start `cmd /c pause` with CREATE_NO_WINDOW (its console has no window, and
 *                                          Windows Terminal is never asked to host it), AttachConsole to it, end the helper. The
 *                                          console lives on while this process is attached. No window at any point.
 *   3. AllocConsole() + ShowWindow(SW_HIDE) last resort (may flash once; with Windows Terminal as the default terminal it can open a
 *                                          terminal window, which is why 2 comes first). Skipped when `visibleFallback` is false.
 *
 * Returns what it did: 'has-console' (nothing to do), 'no-window' (1), 'attached' (2), 'hidden' (3), 'not-windows', or 'failed'.
 */
import { allocConsoleWithOptions, kernel32, user32, wide } from './win32.ts';

export type ConsoleResult = 'has-console' | 'no-window' | 'attached' | 'hidden' | 'not-windows' | 'failed';

export interface HiddenConsoleOptions {
  /** Skip step 1 (tests use it to exercise step 2 on a new Windows). */
  skipNoWindowMode?: boolean;
  /** Allow step 3, which may show a window for a moment. Default true. */
  visibleFallback?: boolean;
}

const ALLOC_CONSOLE_MODE_NO_WINDOW = 2;
const SW_HIDE = 0;
const CREATE_NO_WINDOW = 0x08000000;

/** Step 2: borrow the windowless console of a short-lived CREATE_NO_WINDOW helper. True when this process now has a console. */
function attachToWindowlessConsole(): boolean {
  const k = kernel32();
  const system = Deno.env.get('SystemRoot') || Deno.env.get('windir') || 'C:\\Windows';
  const cmd = `${system}\\System32\\cmd.exe`;
  const startup = new Uint8Array(104); // STARTUPINFOW (64-bit)
  new DataView(startup.buffer).setUint32(0, 104, true);
  const info = new Uint8Array(24); // PROCESS_INFORMATION
  const application = wide(cmd); // kept in variables until the call returns
  const commandLine = wide(`"${cmd}" /d /q /c pause>nul`);
  const cwd = wide(system);
  const ok = k.CreateProcessW(Deno.UnsafePointer.of(application), commandLine, null, null, 0, CREATE_NO_WINDOW, null, cwd, startup, info);
  if (!ok) return false;
  const view = new DataView(info.buffer);
  const process = Deno.UnsafePointer.create(view.getBigUint64(0, true));
  const thread = Deno.UnsafePointer.create(view.getBigUint64(8, true));
  const pid = view.getUint32(16, true);
  let attached = false;
  try {
    const deadline = Date.now() + 3000;
    while (!attached && Date.now() < deadline) {
      attached = k.AttachConsole(pid) !== 0;
      if (!attached) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // its console is made as it starts
    }
  } finally {
    if (process !== null) {
      k.TerminateProcess(process, 0);
      k.CloseHandle(process);
    }
    if (thread !== null) k.CloseHandle(thread);
  }
  return attached;
}

export function ensureHiddenConsole(options: HiddenConsoleOptions = {}): ConsoleResult {
  if (Deno.build.os !== 'windows') return 'not-windows';
  try {
    // GetConsoleCP is 0 only without a console; a windowless console (NO_WINDOW, CREATE_NO_WINDOW) has no window handle.
    if (kernel32().GetConsoleWindow() !== null || kernel32().GetConsoleCP() !== 0) return 'has-console';
    if (!options.skipNoWindowMode) {
      const alloc = allocConsoleWithOptions();
      if (alloc) {
        // ALLOC_CONSOLE_OPTIONS { ALLOC_CONSOLE_MODE mode; BOOL useShowWindow; WORD showWindow (padded) }
        if (alloc(new Uint32Array([ALLOC_CONSOLE_MODE_NO_WINDOW, 0, 0]), new Uint32Array(1)) === 0) return 'no-window';
      }
    }
    try {
      if (attachToWindowlessConsole()) return 'attached';
    } catch { /* fall through */ }
    if (options.visibleFallback === false) return 'failed';
    if (!kernel32().AllocConsole()) return 'failed';
    const window = kernel32().GetConsoleWindow();
    if (window !== null) user32().ShowWindow(window, SW_HIDE);
    return 'hidden';
  } catch {
    return 'failed';
  }
}
