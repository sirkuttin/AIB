/**
 * Start a process that outlives its parent, its console and its job, with stdout and stderr appended to a log file
 * (host_client.spawn_detached). Used to start the agent host.
 *
 * Windows: Deno.Command cannot pass creation flags or redirect to a file, so this calls CreateProcessW directly with the Python
 * server's flags: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, first with CREATE_BREAKAWAY_FROM_JOB and, if the
 * launching job does not allow breakaway, without it. Only the log and NUL handles are inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
 * never whatever else this process has open. POSIX: `sh -c 'exec "$@" >>log 2>&1'` in a new session (Deno's detached option).
 */
import { kernel32, wide } from './win32.ts';

export interface DetachedProcess {
  readonly pid: number;
  /** The exit code once it has exited, else null. */
  exitCode(): number | null;
  /** Release the handle this process keeps on it (it keeps running). */
  close(): void;
}

const DETACHED_PROCESS = 0x00000008;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_NO_WINDOW = 0x08000000;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const STARTF_USESTDHANDLES = 0x00000100;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
const FILE_APPEND_DATA = 0x0004, GENERIC_READ = 0x80000000, SYNCHRONIZE = 0x00100000;
const OPEN_ALWAYS = 4, OPEN_EXISTING = 3, FILE_ATTRIBUTE_NORMAL = 0x80;
const STILL_ACTIVE = 259;

/** One Windows command-line argument, quoted exactly like subprocess.list2cmdline (the MSVC runtime parses it back unchanged). */
export function quoteWindowsArg(arg: string): string {
  const needQuote = arg === '' || arg.includes(' ') || arg.includes('\t');
  let out = needQuote ? '"' : '';
  let backslashes = '';
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += ch;
    } else if (ch === '"') {
      out += backslashes + backslashes + '\\"';
      backslashes = '';
    } else {
      out += backslashes + ch;
      backslashes = '';
    }
  }
  out += backslashes;
  return needQuote ? out + backslashes + '"' : out;
}

function pointerValue(p: Deno.PointerValue): bigint {
  return p === null ? 0n : BigInt(Deno.UnsafePointer.value(p));
}

function inheritableHandle(path: string, access: number, disposition: number): Deno.PointerValue {
  const security = new Uint8Array(24); // SECURITY_ATTRIBUTES { nLength, lpSecurityDescriptor, bInheritHandle }
  const view = new DataView(security.buffer);
  view.setUint32(0, 24, true);
  view.setUint32(16, 1, true);
  const handle = kernel32().CreateFileW(
    wide(path),
    access,
    0x7, /* read|write|delete share */
    security,
    disposition,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  if (handle === null || pointerValue(handle) === 0xffffffffffffffffn) {
    throw new Error(`Could not open ${path} (error ${kernel32().GetLastError()})`);
  }
  return handle;
}

/** A UTF-16 environment block: NAME=value\0...\0\0, sorted case-insensitively as Windows expects. */
function environmentBlock(env: Record<string, string>): Uint16Array<ArrayBuffer> {
  const entries = Object.entries(env).sort(([a], [b]) =>
    a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0
  );
  return wide(entries.map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
}

function spawnWindows(
  command: string[] | string,
  logFile: string,
  cwd: string,
  env: Record<string, string> | undefined,
  errFile?: string,
): DetachedProcess {
  const k = kernel32();
  const log = inheritableHandle(logFile, FILE_APPEND_DATA | SYNCHRONIZE, OPEN_ALWAYS);
  let err: Deno.PointerValue = log;
  let nul: Deno.PointerValue = null;
  try {
    if (errFile) err = inheritableHandle(errFile, FILE_APPEND_DATA | SYNCHRONIZE, OPEN_ALWAYS);
    nul = inheritableHandle('NUL', GENERIC_READ, OPEN_EXISTING);
    const handles = new BigUint64Array([pointerValue(log), pointerValue(nul), ...(err !== log ? [pointerValue(err)] : [])]);
    const size = new BigUint64Array(1);
    k.InitializeProcThreadAttributeList(new Uint8Array(0), 1, 0, new Uint8Array(size.buffer)); // asks for the size
    const attributes = new Uint8Array(Number(size[0]));
    if (!k.InitializeProcThreadAttributeList(attributes, 1, 0, new Uint8Array(size.buffer))) {
      throw new Error('InitializeProcThreadAttributeList failed');
    }
    try {
      if (
        !k.UpdateProcThreadAttribute(
          attributes,
          0,
          BigInt(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
          new Uint8Array(handles.buffer),
          BigInt(handles.byteLength),
          null,
          null,
        )
      ) {
        throw new Error('UpdateProcThreadAttribute failed');
      }
      const startup = new Uint8Array(112); // STARTUPINFOEXW
      const view = new DataView(startup.buffer);
      view.setUint32(0, 112, true);
      view.setUint32(60, STARTF_USESTDHANDLES, true);
      view.setBigUint64(80, pointerValue(nul), true);
      view.setBigUint64(88, pointerValue(log), true);
      view.setBigUint64(96, pointerValue(err), true);
      view.setBigUint64(104, pointerValue(Deno.UnsafePointer.of(attributes)), true);
      const commandLine = wide(typeof command === 'string' ? command : command.map(quoteWindowsArg).join(' '));
      const block = env ? environmentBlock(env) : null;
      const base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT |
        (block ? CREATE_UNICODE_ENVIRONMENT : 0);
      const info = new Uint8Array(24); // PROCESS_INFORMATION
      const cwdWide = wide(cwd);
      const create = (flags: number) =>
        k.CreateProcessW(null, commandLine, null, null, 1, flags, block ? Deno.UnsafePointer.of(block) : null, cwdWide, startup, info);
      if (!create(base | CREATE_BREAKAWAY_FROM_JOB) && !create(base)) throw new Error(`CreateProcessW failed (error ${k.GetLastError()})`);
      const infoView = new DataView(info.buffer);
      const process = Deno.UnsafePointer.create(infoView.getBigUint64(0, true));
      const thread = Deno.UnsafePointer.create(infoView.getBigUint64(8, true));
      if (thread !== null) k.CloseHandle(thread);
      const pid = infoView.getUint32(16, true);
      let handle: Deno.PointerValue = process;
      return {
        pid,
        exitCode() {
          if (handle === null) return null;
          const code = new Uint32Array(1);
          if (!k.GetExitCodeProcess(handle, code) || code[0] === STILL_ACTIVE) return null;
          return code[0];
        },
        close() {
          if (handle !== null) k.CloseHandle(handle);
          handle = null;
        },
      };
    } finally {
      k.DeleteProcThreadAttributeList(attributes);
    }
  } finally {
    k.CloseHandle(log);
    if (err !== log) k.CloseHandle(err);
    if (nul !== null) k.CloseHandle(nul);
  }
}

function spawnPosix(command: string[], logFile: string, cwd: string | undefined, env: Record<string, string> | undefined): DetachedProcess {
  const child = new Deno.Command('/bin/sh', {
    args: ['-c', 'exec "$@" >>"$AIB_DETACHED_LOG" 2>&1 </dev/null', 'sh', ...command],
    cwd,
    env: { ...(env ?? Deno.env.toObject()), AIB_DETACHED_LOG: logFile },
    clearEnv: env !== undefined,
    detached: true,
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  child.unref();
  let code: number | null = null;
  child.status.then((s) => (code = s.code));
  return { pid: child.pid, exitCode: () => code, close() {} };
}

/** Start `command` detached with output appended to logFile (its folder is created). env replaces the environment when given. */
export async function spawnDetached(
  command: string[],
  logFile: string,
  cwd?: string,
  env?: Record<string, string>,
): Promise<DetachedProcess> {
  const folder = logFile.replace(/[\\/][^\\/]*$/, '');
  if (folder && folder !== logFile) await Deno.mkdir(folder, { recursive: true });
  return Deno.build.os === 'windows' ? spawnWindows(command, logFile, cwd ?? Deno.cwd(), env) : spawnPosix(command, logFile, cwd, env);
}

/**
 * Windows: start an exact command line (passed to CreateProcessW unchanged, as subprocess.Popen does with a str) detached, with
 * stdout appended to outFile and stderr to errFile (deploy.launch_direct).
 */
export async function spawnDetachedLine(commandLine: string, outFile: string, errFile: string, cwd: string): Promise<DetachedProcess> {
  if (Deno.build.os !== 'windows') throw new Error('spawnDetachedLine is for Windows');
  for (const file of [outFile, errFile]) {
    const folder = file.replace(/[\\/][^\\/]*$/, '');
    if (folder && folder !== file) await Deno.mkdir(folder, { recursive: true });
  }
  return spawnWindows(commandLine, outFile, cwd, undefined, errFile);
}
