"""Kill an agent process together with everything it started."""
import logging
import os
import subprocess

log = logging.getLogger(__name__)


class ProcessTree:
    """Kills an agent process together with everything it started (the claude CLI, MCP servers, ...).
    POSIX: the agent leads its own session/process group, so killpg reaches all of them, even after the adapter has exited.
    Windows: the agent joins a Job Object right after it starts; terminating the job reaches every descendant, also after the adapter
    has exited (taskkill /T cannot, because the parent link is gone by then). If no job could be made, taskkill /T is the fallback."""

    def __init__(self, process):
        self.process = process
        self.pid = process.pid
        self.job = None
        if os.name == 'nt':
            self.job = self._make_job(process)

    @staticmethod
    def _make_job(process):
        try:
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            kernel.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
            kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            job = kernel.CreateJobObjectW(None, None)
            if not job:
                return None
            if not kernel.AssignProcessToJobObject(job, wintypes.HANDLE(int(process._handle))):
                kernel.CloseHandle(job)
                return None
            return (kernel, job)
        except Exception:
            log.exception('Could not create a Windows job object for the agent process tree')
            return None

    def kill(self):
        """Hard-kill the whole tree. Safe to call repeatedly and after the adapter exited."""
        if os.name == 'nt':
            job, self.job = self.job, None
            if job:
                try:
                    job[0].TerminateJobObject(job[1], 1)
                    job[0].CloseHandle(job[1])
                except Exception:
                    log.exception('Terminating the agent job object failed')
            elif self.process.poll() is None:
                try:
                    subprocess.run(['taskkill', '/PID', str(self.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                except (OSError, subprocess.SubprocessError):
                    pass
        else:
            import signal
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
        try:
            self.process.kill()
        except OSError:
            pass
