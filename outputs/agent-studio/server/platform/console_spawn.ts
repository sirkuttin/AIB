/**
 * Start a program in its own visible console window (Windows CREATE_NEW_CONSOLE), as agent_signin._spawn_console does for an
 * agent's terminal sign-in. Deno.Command cannot pass creation flags, so this calls CreateProcessW. Windows only: macOS / Linux
 * show the command to the user instead of starting it.
 */
import { kernel32, STILL_ACTIVE, wide } from './win32.ts';
import { quoteWindowsArg } from './spawn_detached.ts';

const CREATE_NEW_CONSOLE = 0x00000010;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;

export interface ConsoleProcess {
  readonly pid: number;
  /** Resolves with the exit code when the program ends. */
  readonly status: Promise<{ code: number }>;
  kill(signal?: Deno.Signal): void;
}

function environmentBlock(env: Record<string, string>): Uint16Array<ArrayBuffer> {
  const entries = Object.entries(env).sort((
    [a],
    [b],
  ) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
  return wide(entries.map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
}

export function spawnInNewConsole(argv: string[], env: Record<string, string>): ConsoleProcess {
  if (Deno.build.os !== 'windows') throw new Error('A new console window is only opened on Windows');
  const k = kernel32();
  const startup = new Uint8Array(104); // STARTUPINFOW
  new DataView(startup.buffer).setUint32(0, 104, true);
  const info = new Uint8Array(24); // PROCESS_INFORMATION
  const block = environmentBlock(env);
  const commandLine = wide(argv.map(quoteWindowsArg).join(' '));
  const ok = k.CreateProcessW(
    null,
    commandLine,
    null,
    null,
    0,
    CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
    Deno.UnsafePointer.of(block),
    wide(Deno.cwd()),
    startup,
    info,
  );
  if (!ok) throw new Error(`CreateProcessW failed (error ${k.GetLastError()})`);
  const view = new DataView(info.buffer);
  let handle = Deno.UnsafePointer.create(view.getBigUint64(0, true));
  const thread = Deno.UnsafePointer.create(view.getBigUint64(8, true));
  if (thread !== null) k.CloseHandle(thread);
  const pid = view.getUint32(16, true);
  let exitCode: number | null = null;
  const status = new Promise<{ code: number }>((resolve) => {
    const poll = () => {
      const code = new Uint32Array(1);
      if (handle !== null && k.GetExitCodeProcess(handle, code) && code[0] !== STILL_ACTIVE) {
        exitCode = code[0] | 0;
        k.CloseHandle(handle);
        handle = null;
        resolve({ code: exitCode });
      } else if (handle === null) resolve({ code: exitCode ?? 1 });
      else setTimeout(poll, 200);
    };
    poll();
  });
  return {
    pid,
    status,
    kill() {
      if (exitCode !== null) return;
      try {
        new Deno.Command('taskkill', { args: ['/PID', String(pid), '/T', '/F'], stdout: 'null', stderr: 'null' }).outputSync();
      } catch { /* already gone */ }
    },
  };
}
