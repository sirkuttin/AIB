/**
 * A real pseudo-terminal running a shell, for the per-chat terminal panel (server/terminal/sessions.ts).
 *
 *   Windows       ConPTY through FFI (pty_windows.ts): CreatePseudoConsole on two anonymous pipes, CreateProcessW with
 *                 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE. The console host runs headless, so no window ever appears. The shell and
 *                 everything it starts sit in a Job Object that kills them all when the job closes (also when AIB dies).
 *   macOS, Linux  openpty + posix_spawn through FFI (pty_posix.ts): the shell leads a new session with the pty as its controlling
 *                 terminal. Not run on a real Mac or Linux machine yet (the tests skip there are none; they run on Windows).
 *
 * Output arrives as raw bytes (UTF-8 with VT sequences); input is written as bytes or text.
 */
import { join } from './path.ts';
import { spawnConPty } from './pty_windows.ts';
import { spawnPosixPty } from './pty_posix.ts';

export interface PtyOptions {
  /** The program and its arguments (defaultShell() picks one). */
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** Extra environment variables on top of this process's environment. */
  env?: Record<string, string>;
}

export interface Pty {
  readonly pid: number;
  /** Called with each chunk the shell writes. Set it before the first await after spawning to miss nothing. */
  onData: ((bytes: Uint8Array) => void) | null;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** End the shell and everything it started. Safe to call more than once. Resolves when all handles are closed. */
  kill(): Promise<void>;
  /** Synchronous hard stop (used while the process exits); kill() is the normal way. */
  terminate(): void;
  /**
   * True while a command is running in the shell (so typed text would go to that command, not the prompt). Windows: the shell's Job
   * Object holds more than the shell itself (every program a command starts joins it; background jobs count too). macOS / Linux: the
   * terminal's foreground process group is not the shell's (tcgetpgrp). Built-in commands that run inside the shell (a PowerShell
   * Start-Sleep, a bash `read`) are not seen.
   */
  busy(): boolean;
  /** Resolves with the exit code once the shell has ended and its output is drained. */
  readonly exited: Promise<number>;
}

export interface ShellSpec {
  file: string;
  args: string[];
}

/** First match for `name` on PATH (Windows: also tries PATHEXT suffixes when `name` has none), or null. */
export function findOnPath(name: string, path = Deno.env.get('PATH') ?? Deno.env.get('Path') ?? ''): string | null {
  const win = Deno.build.os === 'windows';
  for (const dir of path.split(win ? ';' : ':')) {
    if (!dir.trim()) continue;
    const full = join(dir.trim().replace(/^"|"$/g, ''), name);
    try {
      if (Deno.statSync(full).isFile) return full;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * The shell the terminal runs. Windows: PowerShell 7 (pwsh.exe) when it is on PATH, else Windows PowerShell. macOS and Linux: $SHELL
 * as a login shell, else /bin/bash.
 */
export function defaultShell(env: { get(name: string): string | undefined } = Deno.env): ShellSpec {
  if (Deno.build.os === 'windows') {
    const pwsh = findOnPath('pwsh.exe', env.get('PATH') ?? env.get('Path') ?? '');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
    const root = env.get('SystemRoot') || env.get('windir') || 'C:\\Windows';
    return { file: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ['-NoLogo'] };
  }
  const shell = env.get('SHELL');
  return shell && shell.startsWith('/') ? { file: shell, args: ['-l'] } : { file: '/bin/bash', args: ['-l'] };
}

/** Clamp a terminal size to something every PTY accepts. */
export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const n = (v: unknown, fallback: number, max: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x >= 2 ? Math.min(x, max) : fallback;
  };
  return { cols: n(cols, 80, 1000), rows: n(rows, 24, 500) };
}

/** Start `options.file` on a new pseudo-terminal. Throws when it cannot start (the folder is missing, the program is not found). */
export function spawnPty(options: PtyOptions): Pty {
  const size = clampSize(options.cols, options.rows);
  return Deno.build.os === 'windows' ? spawnConPty({ ...options, ...size }) : spawnPosixPty({ ...options, ...size });
}
