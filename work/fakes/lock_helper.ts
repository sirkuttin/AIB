/**
 * A foreign process for the lock tests: it holds, or tries to take, an advisory file lock the way another program would, through the
 * operating system's own calls and none of AIB's code (LockFile on Windows, one byte at offset 0, the lock file gets one NUL byte first;
 * flock elsewhere). A Deno script only because Deno can call the system libraries; it shares nothing with FileLock but the lock itself.
 *
 *     deno run -A lock_helper.ts hold <path> [seconds]   take the lock, print "locked", keep it until stdin closes
 *     deno run -A lock_helper.ts try  <path> [seconds]   try the lock for a short time; print "yes" (got it, released) or "no"
 *
 * platform_test.ts, ownership_test.ts and worktree_sync_interop_test.ts use it to check that FileLock excludes another program.
 */
const WIN = Deno.build.os === 'windows';
function wide(text: string): Uint8Array {
  const bytes = new Uint8Array((text.length + 1) * 2); // UTF-16LE, NUL-terminated
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return bytes;
}

interface Os {
  open(path: string): unknown;
  lock(handle: unknown): boolean;
  unlock(handle: unknown): void;
  close(handle: unknown): void;
}

function windows(): Os {
  const k = Deno.dlopen('kernel32.dll', {
    CreateFileW: { parameters: ['buffer', 'u32', 'u32', 'pointer', 'u32', 'u32', 'pointer'], result: 'pointer' },
    LockFile: { parameters: ['pointer', 'u32', 'u32', 'u32', 'u32'], result: 'i32' },
    UnlockFile: { parameters: ['pointer', 'u32', 'u32', 'u32', 'u32'], result: 'i32' },
    CloseHandle: { parameters: ['pointer'], result: 'i32' },
  } as const);
  return {
    open(path) {
      // GENERIC_READ | GENERIC_WRITE, share read and write, OPEN_ALWAYS: what Python's open(path, 'a+b') does
      const handle = k.symbols.CreateFileW(wide(path), 0xc0000000, 3, null, 4, 0x80, null);
      if (handle === null || Deno.UnsafePointer.value(handle) === 0xffffffffffffffffn) throw new Error('could not open ' + path);
      return handle;
    },
    lock: (handle) => k.symbols.LockFile(handle as Deno.PointerValue, 0, 0, 1, 0) !== 0,
    unlock: (handle) => void k.symbols.UnlockFile(handle as Deno.PointerValue, 0, 0, 1, 0),
    close: (handle) => void k.symbols.CloseHandle(handle as Deno.PointerValue),
  };
}

function posix(): Os {
  const mac = Deno.build.os === 'darwin';
  const libc = Deno.dlopen(mac ? 'libSystem.dylib' : 'libc.so.6', {
    open: { parameters: ['buffer', 'i32', 'i32'], result: 'i32' },
    flock: { parameters: ['i32', 'i32'], result: 'i32' },
    close: { parameters: ['i32'], result: 'i32' },
  } as const);
  const O_RDWR = 2;
  const O_CREAT = mac ? 0x200 : 0x40;
  const O_APPEND = mac ? 0x8 : 0x400;
  const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
  return {
    open(path) {
      const fd = libc.symbols.open(new TextEncoder().encode(path + '\0'), O_RDWR | O_CREAT | O_APPEND, 0o644);
      if (fd < 0) throw new Error('could not open ' + path);
      return fd;
    },
    lock: (fd) => libc.symbols.flock(fd as number, LOCK_EX | LOCK_NB) === 0,
    unlock: (fd) => void libc.symbols.flock(fd as number, LOCK_UN),
    close: (fd) => void libc.symbols.close(fd as number),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquire(os: Os, path: string, seconds: number): Promise<unknown | null> {
  const parent = path.replace(/[\\/][^\\/]*$/, '');
  if (parent && parent !== path) Deno.mkdirSync(parent, { recursive: true });
  if (WIN) {
    const size = (() => {
      try {
        return Deno.statSync(path).size;
      } catch {
        return 0;
      }
    })();
    if (size === 0) Deno.writeFileSync(path, new Uint8Array([0]), { append: true, create: true });
  }
  const handle = os.open(path);
  const deadline = performance.now() + seconds * 1000;
  for (;;) {
    if (os.lock(handle)) return handle;
    if (performance.now() >= deadline) {
      os.close(handle);
      return null;
    }
    await sleep(10);
  }
}

const [mode, path, secondsArg] = Deno.args;
const os = WIN ? windows() : posix();
const seconds = secondsArg !== undefined ? Number(secondsArg) : mode === 'hold' ? 5 : 0.3;
if (mode === 'hold') {
  const handle = await acquire(os, path, seconds);
  if (handle === null) Deno.exit(1);
  console.log('locked');
  for await (const _chunk of Deno.stdin.readable) { /* until stdin closes */ }
  os.unlock(handle);
  os.close(handle);
} else {
  const handle = await acquire(os, path, seconds);
  if (handle === null) console.log('no');
  else {
    os.unlock(handle);
    os.close(handle);
    console.log('yes');
  }
}
