"""P0b probe: a Claude Code `command` hook that records, headless, whether the hook process has a console WINDOW and whether it
is visible (the no-popups rule), plus the chain of parent processes (which shell Claude Code runs hooks through on Windows).

    python work/hook_console_check.py <LOG> <label>

Appends one JSON line {via: "console-check", label, event, console_hwnd, console_visible, chain: [{pid, exe}, ...],
chain_windows: [...]} to LOG. GetConsoleWindow() is 0 when the process runs on a console with no window (CREATE_NO_WINDOW,
inherited by the hook's shell and everything it starts); a non-zero handle with IsWindowVisible() true would mean a window is on
screen. chain_windows: every VISIBLE top-level window (EnumWindows) owned by a process of the chain or by a conhost.exe whose
parent is in it (a console window is drawn by conhost). Nothing is drawn by this check itself.
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [('dwSize', wt.DWORD), ('cntUsage', wt.DWORD), ('th32ProcessID', wt.DWORD), ('th32DefaultHeapID', ctypes.c_void_p),
                ('th32ModuleID', wt.DWORD), ('cntThreads', wt.DWORD), ('th32ParentProcessID', wt.DWORD), ('pcPriClassBase', ctypes.c_long),
                ('dwFlags', wt.DWORD), ('szExeFile', ctypes.c_wchar * 260)]


def processes():
    k32 = ctypes.windll.kernel32
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    table = {}
    ok = k32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        table[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile)
        ok = k32.Process32NextW(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return table


def chain_windows(table, pids):
    """Visible top-level windows of the chain's processes (and of their conhost.exe children): [{pid, exe, cls, title}]."""
    owners = set(pids)
    owners |= {pid for pid, (parent, exe) in table.items() if parent in pids and exe.lower() == 'conhost.exe'}
    user32 = ctypes.windll.user32
    found = []
    proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def each(hwnd, _):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in owners and user32.IsWindowVisible(hwnd):
            cls, title = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            user32.GetWindowTextW(hwnd, title, 256)
            found.append({'pid': pid.value, 'exe': table.get(pid.value, (0, '?'))[1], 'cls': cls.value, 'title': title.value})
        return True
    user32.EnumWindows(proc(each), 0)
    return found


def main():
    log, label = sys.argv[1], sys.argv[2]
    raw = sys.stdin.read()
    try:
        event = json.loads(raw).get('hook_event_name')
    except ValueError:
        event = None
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    visible = bool(ctypes.windll.user32.IsWindowVisible(hwnd)) if hwnd else False
    table = processes()
    chain, pid = [], os.getpid()
    for _ in range(8):
        if pid not in table:
            break
        parent, exe = table[pid]
        chain.append({'pid': pid, 'exe': exe})
        pid = parent
    windows = chain_windows(table, {c['pid'] for c in chain})
    with open(log, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'at': int(time.time() * 1000), 'via': 'console-check', 'label': label, 'event': event,
                            'console_hwnd': int(hwnd or 0), 'console_visible': visible, 'chain': chain,
                            'chain_windows': windows}) + '\n')


if __name__ == '__main__':
    main()
