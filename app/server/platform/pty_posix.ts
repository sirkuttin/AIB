/**
 * macOS and Linux pseudo-terminal through FFI, for pty.ts. NOT YET RUN on a real Mac or Linux machine (AIB is developed on
 * Windows); the Windows build never loads it. Deno cannot fork (the child would be a copy of a multi-threaded runtime), so:
 *
 *   openpty            master and slave fds, with the starting window size
 *   posix_spawn        POSIX_SPAWN_SETSID (the shell leads a new session), then file actions open the slave by its path on fd 0 (a
 *                      session leader opening a tty without O_NOCTTY makes it its controlling terminal on Linux; macOS is expected
 *                      to do the same, unverified), dup it to 1 and 2, close our copies. Signals the runtime ignores (SIGPIPE) are
 *                      reset to default and the signal mask cleared, so the shell behaves as in a normal terminal.
 *   poll + read/write  on Deno's blocking-call threads (nonblocking FFI symbols); poll has a timeout so a stopped reader never hangs
 *   ioctl TIOCSWINSZ   resize (the kernel sends SIGWINCH to the foreground job). ioctl is variadic: on Apple arm64 a variadic argument
 *                      goes on the stack, so there the pointer is declared as the ninth argument (after eight register slots).
 *   kill               SIGHUP to the shell's process group, SIGKILL after a moment; waitpid gives the exit code.
 */
import type { Pty, PtyOptions } from './pty.ts';

const mac = Deno.build.os === 'darwin';
const appleArm = mac && Deno.build.arch === 'aarch64';

const ioctlParams = appleArm
  ? ['i32', 'u64', 'u64', 'u64', 'u64', 'u64', 'u64', 'u64', 'pointer'] as const
  : ['i32', 'u64', 'pointer'] as const;

const symbols = {
  openpty: { parameters: ['buffer', 'buffer', 'pointer', 'pointer', 'buffer'], result: 'i32' },
  ttyname: { parameters: ['i32'], result: 'pointer' },
  close: { parameters: ['i32'], result: 'i32' },
  ioctl: { parameters: ioctlParams, result: 'i32' },
  poll: { parameters: ['buffer', 'u64', 'i32'], result: 'i32', nonblocking: true },
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize', nonblocking: true },
  write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize', nonblocking: true },
  waitpid: { parameters: ['i32', 'buffer', 'i32'], result: 'i32', nonblocking: true },
  posix_spawn: { parameters: ['buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  posix_spawn_file_actions_init: { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_destroy: { parameters: ['buffer'], result: 'i32' },
  posix_spawn_file_actions_addopen: { parameters: ['buffer', 'i32', 'buffer', 'i32', 'u32'], result: 'i32' },
  posix_spawn_file_actions_adddup2: { parameters: ['buffer', 'i32', 'i32'], result: 'i32' },
  posix_spawn_file_actions_addclose: { parameters: ['buffer', 'i32'], result: 'i32' },
  posix_spawn_file_actions_addchdir_np: { parameters: ['buffer', 'buffer'], result: 'i32' },
  posix_spawnattr_init: { parameters: ['buffer'], result: 'i32' },
  posix_spawnattr_destroy: { parameters: ['buffer'], result: 'i32' },
  posix_spawnattr_setflags: { parameters: ['buffer', 'i16'], result: 'i32' },
  posix_spawnattr_setsigmask: { parameters: ['buffer', 'buffer'], result: 'i32' },
  posix_spawnattr_setsigdefault: { parameters: ['buffer', 'buffer'], result: 'i32' },
  sigemptyset: { parameters: ['buffer'], result: 'i32' },
  sigaddset: { parameters: ['buffer', 'i32'], result: 'i32' },
  tcgetpgrp: { parameters: ['i32'], result: 'i32' },
} as const;

type Libc = Deno.DynamicLibrary<typeof symbols>['symbols'];
let libc: Libc | null = null;

function load(): Libc {
  if (libc) return libc;
  if (mac) return (libc = Deno.dlopen('/usr/lib/libSystem.B.dylib', symbols).symbols);
  try {
    return (libc = Deno.dlopen('libc.so.6', symbols).symbols);
  } catch { /* glibc before 2.34 keeps openpty in libutil */ }
  const { openpty, ...rest } = symbols;
  const base = Deno.dlopen('libc.so.6', rest).symbols;
  const util = Deno.dlopen('libutil.so.1', { openpty }).symbols;
  return (libc = { ...base, openpty: util.openpty } as Libc);
}

const O_RDWR = 2;
const POSIX_SPAWN_SETSIGDEF = 0x04;
const POSIX_SPAWN_SETSIGMASK = 0x08;
const POSIX_SPAWN_SETSID = mac ? 0x0400 : 0x80;
const POSIX_SPAWN_CLOEXEC_DEFAULT = 0x4000; // macOS only: every fd not named in the file actions is closed in the child
const TIOCSWINSZ = mac ? 0x80087467n : 0x5414n;
const FIOCLEX = mac ? 0x20006601n : 0x5451n;
const SIGNALS_TO_DEFAULT = [1, 2, 3, 13, 15, mac ? 20 : 17]; // HUP INT QUIT PIPE TERM CHLD
const POLLIN = 0x1;

const cstr = (text: string) => new TextEncoder().encode(text + '\0');

/** A NULL-terminated array of pointers to C strings; the strings are returned too so they stay alive. */
function cArray(items: string[]): { array: BigUint64Array<ArrayBuffer>; keep: Uint8Array[] } {
  const keep = items.map(cstr);
  const array = new BigUint64Array(items.length + 1);
  keep.forEach((s, i) => (array[i] = BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(s)))));
  return { array, keep };
}

function winsize(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  const w = new Uint16Array([rows, cols, 0, 0]); // struct winsize { ws_row, ws_col, ws_xpixel, ws_ypixel }
  return new Uint8Array(w.buffer);
}

function ioctl(lib: Libc, fd: number, request: bigint, arg: Deno.PointerValue): number {
  const call = lib.ioctl as unknown as (...args: unknown[]) => number;
  return appleArm ? call(fd, request, 0n, 0n, 0n, 0n, 0n, 0n, arg) : call(fd, request, arg);
}

export function spawnPosixPty(options: PtyOptions): Pty {
  const lib = load();
  const masterBox = new Int32Array(1), slaveBox = new Int32Array(1);
  const size = winsize(options.cols, options.rows);
  if (lib.openpty(new Uint8Array(masterBox.buffer), new Uint8Array(slaveBox.buffer), null, null, size) !== 0) {
    throw new Error('openpty failed');
  }
  const master = masterBox[0], slave = slaveBox[0];
  ioctl(lib, master, FIOCLEX, null); // other programs AIB starts must not inherit the master
  const namePtr = lib.ttyname(slave);
  if (namePtr === null) {
    lib.close(master), lib.close(slave);
    throw new Error('ttyname failed');
  }
  const slavePath = Deno.UnsafePointerView.getCString(namePtr);

  const actions = new Uint8Array(256), attr = new Uint8Array(512);
  const sigmask = new Uint8Array(256), sigdef = new Uint8Array(256);
  lib.posix_spawn_file_actions_init(actions);
  lib.posix_spawnattr_init(attr);
  let pid = 0;
  try {
    const path = cstr(slavePath);
    const cwd = cstr(options.cwd);
    lib.posix_spawn_file_actions_addchdir_np(actions, cwd);
    lib.posix_spawn_file_actions_addopen(actions, 0, path, O_RDWR, 0);
    lib.posix_spawn_file_actions_adddup2(actions, 0, 1);
    lib.posix_spawn_file_actions_adddup2(actions, 0, 2);
    lib.posix_spawn_file_actions_addclose(actions, master);
    lib.posix_spawn_file_actions_addclose(actions, slave);
    lib.sigemptyset(sigmask);
    lib.sigemptyset(sigdef);
    for (const s of SIGNALS_TO_DEFAULT) lib.sigaddset(sigdef, s);
    lib.posix_spawnattr_setsigmask(attr, sigmask);
    lib.posix_spawnattr_setsigdefault(attr, sigdef);
    let flags = POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK;
    if (mac) flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
    lib.posix_spawnattr_setflags(attr, flags);
    const env = { ...Deno.env.toObject(), TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(options.env ?? {}) };
    const argv = cArray([options.file, ...options.args]);
    const envp = cArray(Object.entries(env).map(([k, v]) => `${k}=${v}`));
    const pidBox = new Int32Array(1);
    const rc = lib.posix_spawn(
      new Uint8Array(pidBox.buffer),
      cstr(options.file),
      actions,
      attr,
      new Uint8Array(argv.array.buffer),
      new Uint8Array(envp.array.buffer),
    );
    void argv.keep, void envp.keep;
    if (rc !== 0) throw new Error(`Could not start ${options.file} (errno ${rc})`);
    pid = pidBox[0];
  } catch (error) {
    lib.close(master);
    throw error;
  } finally {
    lib.posix_spawn_file_actions_destroy(actions);
    lib.posix_spawnattr_destroy(attr);
    lib.close(slave);
  }

  let open = true;
  let killing: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();

  const pty: Pty = {
    pid,
    onData: null,
    write(data) {
      if (!open) return;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      writes = writes.then(async () => {
        let offset = 0;
        while (open && offset < bytes.length) {
          const chunk = bytes.subarray(offset);
          const n = Number(await lib.write(master, chunk, BigInt(chunk.length)));
          if (n <= 0) break;
          offset += n;
        }
      }).catch(() => {});
    },
    resize(cols, rows) {
      if (open) ioctl(lib, master, TIOCSWINSZ, Deno.UnsafePointer.of(winsize(cols, rows)));
    },
    terminate() {
      try {
        Deno.kill(-pid, 'SIGKILL');
      } catch { /* gone */ }
    },
    busy() {
      if (!open) return false;
      const group = lib.tcgetpgrp(master);
      return group > 0 && group !== pid;
    },
    kill() {
      killing ??= (async () => {
        try {
          Deno.kill(-pid, 'SIGHUP');
        } catch { /* gone */ }
        const timer = setTimeout(() => {
          try {
            Deno.kill(-pid, 'SIGKILL');
          } catch { /* gone */ }
        }, 1500);
        await pty.exited;
        clearTimeout(timer);
      })();
      return killing;
    },
    exited: null as unknown as Promise<number>,
  };

  let childDone = false;
  const reading = (async () => {
    const pfd = new Uint8Array(8); // struct pollfd { int fd; short events; short revents; }
    const view = new DataView(pfd.buffer);
    const buffer = new Uint8Array(64 * 1024);
    let idleAfterExit = 0;
    while (true) {
      view.setInt32(0, master, true);
      view.setInt16(4, POLLIN, true);
      view.setInt16(6, 0, true);
      const ready = await lib.poll(pfd, 1n, 250);
      if (ready > 0) {
        const n = Number(await lib.read(master, buffer, BigInt(buffer.length)));
        if (n <= 0) break; // EIO: no process has the slave open any more
        try {
          pty.onData?.(buffer.slice(0, n));
        } catch { /* a listener's error is not the terminal's */ }
        idleAfterExit = 0;
      } else if (ready < 0) break;
      else if (childDone && ++idleAfterExit >= 4) break; // a background job still holds the tty: stop after a second of quiet
    }
  })();

  (pty as { exited: Promise<number> }).exited = (async () => {
    const status = new Int32Array(1);
    await lib.waitpid(pid, new Uint8Array(status.buffer), 0);
    childDone = true;
    try {
      Deno.kill(-pid, 'SIGHUP'); // what is left of its process group
    } catch { /* none */ }
    await reading;
    open = false;
    await writes;
    lib.close(master);
    const s = status[0];
    return (s & 0x7f) === 0 ? (s >> 8) & 0xff : 128 + (s & 0x7f);
  })();
  return pty;
}
