"""Cross-process session ownership and conservative external-process detection."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from typing import Iterable, Mapping, Optional


class OwnershipConflict(RuntimeError):
    """Raised when another process already owns a provider/session lease."""


class SessionLease:
    """An advisory, nonblocking lease held for this process lifetime."""

    def __init__(self, state_dir, provider, session_id):
        self.state_dir = Path(state_dir)
        self.provider = str(provider)
        self.session_id = str(session_id)
        key = json.dumps([self.provider, self.session_id], ensure_ascii=False, separators=(",", ":"))
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        self.path = self.state_dir / "session-leases" / (digest + ".lock")
        self._file = None

    @classmethod
    def at_path(cls, path):
        """A lease for an existing lease file whose provider and session id are unknown (the file name is only their hash).
        Use acquire(create=False) so that probing never changes the file."""
        lease = cls(Path(path).parent.parent, "", "")
        lease.path = Path(path)
        return lease

    def acquire(self, create=True):
        """Take the lease or raise OwnershipConflict. create=False only opens an existing file and never writes to it."""
        if self._file is not None:
            return self
        if create:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            handle = open(self.path, "a+b" if create else "r+b")
        except OSError as exc:
            if create:
                raise
            raise OwnershipConflict(f"Lease file {self.path} cannot be opened: {exc}") from exc
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0 and create:
                    handle.write(b"\0")
                    handle.flush()
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError as exc:
                    raise OwnershipConflict(f"Session {self.session_id!r} is already owned for provider {self.provider!r}") from exc
            else:
                import fcntl

                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    raise OwnershipConflict(f"Session {self.session_id!r} is already owned for provider {self.provider!r}") from exc
            self._file = handle
            return self
        except BaseException:
            handle.close()
            raise

    def release(self):
        handle, self._file = self._file, None
        if handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_exc):
        self.release()


def _argv_for_process(proc: Mapping):
    argv = proc.get("argv")
    if isinstance(argv, (list, tuple)):
        return [str(part) for part in argv]
    command = proc.get("commandline", proc.get("CommandLine", proc.get("cmdline")))
    if isinstance(command, (list, tuple)):
        return [str(part) for part in command]
    if not isinstance(command, str):
        return []
    try:
        return shlex.split(command, posix=(os.name != "nt"))
    except ValueError:
        return []


def _is_agent(proc: Mapping, argv):
    raw_name = proc.get("name", proc.get("Name", proc.get("executable", "")))
    if not raw_name and argv:
        raw_name = argv[0]
    name = os.path.basename(str(raw_name)).lower()
    if name.endswith(".exe"):
        name = name[:-4]
    return name in {"claude", "omp"}


def _session_arguments(argv):
    # Require an explicit session selector and compare its complete value.
    index = 1
    while index < len(argv):
        token = argv[index]
        if token in ("--resume", "--session-id"):
            if index + 1 < len(argv):
                yield argv[index + 1].strip(chr(34))
            index += 2
            continue
        for option in ("--resume=", "--session-id="):
            if token.startswith(option):
                yield token[len(option):].strip(chr(34))
                break
        index += 1


def find_external_owner(processes: Iterable[Mapping], provider, session_id, excluded_pids=()):
    """Return a matching external PID, or None when no ownership evidence exists."""
    provider_key = str(provider).lower()
    if provider_key not in {"claude", "omp"}:
        return None
    excluded = {int(pid) for pid in excluded_pids}
    expected_binary = provider_key
    for proc in processes:
        if not isinstance(proc, Mapping):
            continue
        pid = proc.get("pid", proc.get("ProcessId", proc.get("process_id")))
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            continue
        if pid in excluded:
            continue
        argv = _argv_for_process(proc)
        if not _is_agent(proc, argv):
            continue
        raw_name = proc.get("name", proc.get("Name", proc.get("executable", argv[0] if argv else "")))
        image = os.path.basename(str(raw_name)).lower().removesuffix(".exe")
        if image != expected_binary:
            continue
        if any(value == str(session_id) for value in _session_arguments(argv)):
            return pid
    return None


def probe_external_owner(provider, session_id, excluded_pids=()):
    """Read-only Windows process probe. None means probe unavailable or no evidence."""
    if os.name != "nt" or str(provider).lower() not in {"claude", "omp"}:
        return None
    script = (
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('claude.exe','omp.exe') } | Select-Object ProcessId,Name,CommandLine | "
        "ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=8, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        data = json.loads(completed.stdout or "[]")
        if isinstance(data, dict):
            data = [data]
        return find_external_owner(data, provider, session_id, excluded_pids)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        return None


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Inspect best-effort evidence of an external ACP session owner. No processes are changed.")
    parser.add_argument("--provider", choices=("omp", "claude"), required=True)
    parser.add_argument("--session", required=True, help="Exact native session ID")
    args = parser.parse_args()
    owner = probe_external_owner(args.provider, args.session)
    print(json.dumps({"ownerPid": owner, "state": "external_owner_found" if owner is not None else "unknown"}))
