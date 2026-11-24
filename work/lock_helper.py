"""A foreign process for the Deno lock tests: it holds, or tries to take, an advisory file lock the way another program would
(msvcrt.locking on Windows, flock elsewhere, one byte at offset 0; the Windows lock file gets one NUL byte first). Stdlib only.

    python lock_helper.py hold <path> [seconds]   take the lock, print "locked", keep it until stdin closes
    python lock_helper.py try  <path> [seconds]   try the lock for a short time; print "yes" (got it, released) or "no"

work/deno/platform_test.ts and msgqueue_test.ts use it to check that the Deno FileLock excludes a process that is not Deno."""
import os
import pathlib
import sys
import time


def acquire(path, timeout):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, 'a+b')
    deadline = time.monotonic() + timeout
    if os.name == 'nt':
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b'\0')
            handle.flush()
    while True:
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise TimeoutError(path.name)
            time.sleep(0.01)


def release(handle):
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    finally:
        handle.close()


def main(argv):
    mode, path = argv[0], argv[1]
    seconds = float(argv[2]) if len(argv) > 2 else (5 if mode == 'hold' else 0.3)
    if mode == 'hold':
        handle = acquire(path, seconds)
        print('locked', flush=True)
        sys.stdin.read()
        release(handle)
    else:
        try:
            release(acquire(path, seconds))
            print('yes')
        except OSError:
            print('no')


if __name__ == '__main__':
    main(sys.argv[1:])
