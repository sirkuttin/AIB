"""Runs after AIB has quit: waits for the app process to exit, checks the installer's SHA-256 once more, runs it silently (NSIS,
per-user, no admin prompt), then starts the new AIB. Started detached by updater.py with one JSON argument:
{installer, sha256, pid, exe, log, version}. Standard library only, so any Python can run it. Writes a short log next to the installer.
"""
import hashlib
import json
import os
import subprocess
import sys
import time

WAIT_FOR_APP_SECONDS = 90
INSTALL_TIMEOUT_SECONDS = 900


def log(path, text):
    try:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + text + '\n')
    except OSError:
        pass


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def process_alive(pid):
    if os.name == 'nt':
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x100000, False, int(pid))   # SYNCHRONIZE
        if not handle:
            return False
        try:
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == 0x102   # WAIT_TIMEOUT: still running
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def clean_env():
    """The new app must not inherit the old one's launch variables."""
    return {k: v for k, v in os.environ.items() if k != 'PYTHONHOME' and not k.startswith('AIB_') and k != 'AGENT_STUDIO_LAUNCH_NONCE'}


def run(args, alive=process_alive, runner=subprocess.run, spawn=subprocess.Popen, sleep=time.sleep, install_dir=None):
    """Returns 0 when the new version was installed and started, else a non-zero code (the old install is left as it was)."""
    note = args.get('log') or os.devnull
    installer, want, pid, exe = args.get('installer'), str(args.get('sha256') or '').lower(), args.get('pid'), args.get('exe')
    log(note, f'update to {args.get("version")}: waiting for the app (pid {pid}) to quit')
    waited = 0.0
    while pid and alive(pid):
        if waited >= WAIT_FOR_APP_SECONDS:
            log(note, 'the app did not quit; nothing was installed')
            return 2
        sleep(0.5)
        waited += 0.5
    try:
        have = sha256(installer)
    except OSError as error:
        log(note, f'cannot read the installer: {error}')
        return 3
    if have != want:
        log(note, 'the installer does not match its verified checksum; it was not run')
        return 4
    command = [installer, '/S']
    if install_dir:
        command.append('/D=' + install_dir)   # NSIS: must be last, no quotes (used to install somewhere else when testing)
    log(note, 'running the installer silently')
    try:
        done = runner(command, timeout=INSTALL_TIMEOUT_SECONDS, env=clean_env())
    except (OSError, subprocess.SubprocessError) as error:
        log(note, f'the installer could not run: {error}')
        return 5
    if done.returncode != 0:
        log(note, f'the installer failed with code {done.returncode}')
        return 6
    log(note, 'installed; starting the new version')
    flags = (0x00000008 | 0x00000200) if os.name == 'nt' else 0   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        spawn([exe], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True, env=clean_env())
    except OSError as error:
        log(note, f'installed, but could not start AIB: {error}')
        return 7
    return 0


if __name__ == '__main__':
    try:
        arguments = json.loads(sys.argv[1])
    except (IndexError, ValueError):
        sys.exit(1)
    sys.exit(run(arguments))
