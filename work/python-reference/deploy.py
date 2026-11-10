"""Restart a running Agent Studio server (and optionally its agent host) without cutting off a turn.

    python deploy.py                      # restart only the web server on port 8767 (agents keep working)
    python deploy.py --host               # also restart the agent host: wait for idle, stop the host, restart the web server
    python deploy.py --wait               # wait for idle before restarting the web server too
    python deploy.py --port 8790          # another instance
    python deploy.py --dry-run            # report what would happen, change nothing
    python deploy.py --timeout 3600       # give up after an hour (default: wait indefinitely)

Agent Studio runs agents in a long-lived agent host process, so restarting only the web server (the default)
never touches a running turn and needs no waiting: the page reconnects to the same conversations. Changes to
the web side of studio.py, monitor.py and the page files need only that. Changes to the code that talks to
agents (Connection, prompts, permissions, leases; agent_host.py itself) need --host, which waits until every
Studio-owned conversation is idle or closed, asks the host to stop, and starts a new web server (which starts
a new host). Conversations that were open reconnect automatically (unless the server runs with --no-auto-reconnect).

"Idle" means nothing is working, opening, or waiting for your answer, and it must stay so for --settle
seconds (default 15), so a turn between steps is not mistaken for a finished one. A server running with
--in-process (or an older one without an agent host) owns its agents itself: it always waits, and restarting
it ends them. The new server is started with exactly the command line the old one had. Front-end-only
changes do not need this script: refresh the page instead.
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

import state_paths
import app_paths
from app_paths import APP_ROOT

HERE = APP_ROOT
LOGS = APP_ROOT.parent.parent / 'work'


def get(port, path, timeout=5):
    base, headers = f'http://127.0.0.1:{port}', {}
    if path != '/api/live/bootstrap':   # every other /api/ route needs the page token, which bootstrap hands out
        with urllib.request.urlopen(base + '/api/live/bootstrap', timeout=timeout) as response:
            headers['X-Studio-Token'] = json.load(response).get('token', '')
    with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=timeout) as response:
        return json.load(response)


def busy_reasons(listing):
    """Why the server is not safe to restart, as human-readable strings (empty list = idle)."""
    reasons = []
    for c in listing.get('connections', []):
        if c.get('closed'):
            continue
        name = f"{c.get('provider', '?')} in {c.get('cwd', '?')}"
        attention = c.get('attention') or {}
        state = attention.get('state')
        if state is None:  # servers older than the attention summary
            state = 'working' if c.get('busy') else ('opening' if not c.get('ready', True) else 'idle')
        if state in ('working', 'opening', 'needs_you'):
            label = {'working': 'is working', 'opening': 'is still opening', 'needs_you': 'is waiting for your answer'}[state]
            reasons.append(f'{name} {label}')
    return reasons


def command_line_of(pid):
    """The exact command line of a running process (Windows), via CIM."""
    script = f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"
    out = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                         capture_output=True, text=True, timeout=30)
    line = out.stdout.strip()
    if not line:
        raise RuntimeError(f'Could not read the command line of process {pid}')
    return line


def find_pid(port):
    """PID of the Studio server on this port: from bootstrap when it reports one, else by command line."""
    boot = get(port, '/api/live/bootstrap')
    if isinstance(boot.get('pid'), int):
        return boot['pid'], boot
    script = ("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'studio\\.py' } | "
              "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }")
    out = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                         capture_output=True, text=True, timeout=30).stdout
    matches = []
    for row in out.splitlines():
        pid, _, cmd = row.partition('\t')
        explicit = f'--port {port}' in cmd or f'--port={port}' in cmd
        if explicit or (port == 8767 and '--port' not in cmd):
            matches.append(int(pid))
    if len(matches) != 1:
        raise RuntimeError(f'Found {len(matches)} Studio processes that could be port {port}; refusing to guess')
    return matches[0], boot


def wait_until_idle(port, settle, timeout, poll=5):
    started, idle_since, last = time.time(), None, None
    while True:
        try:
            reasons = busy_reasons(get(port, '/api/live/list'))
        except (urllib.error.URLError, OSError) as error:
            raise RuntimeError(f'Studio on port {port} stopped answering: {error}')
        if reasons:
            idle_since = None
            if reasons != last:
                print('Waiting: ' + '; '.join(reasons), flush=True)
                last = reasons
        else:
            idle_since = idle_since or time.time()
            if last != 'idle':
                print(f'Idle; restarting if it stays idle for {settle}s...', flush=True)
                last = 'idle'
            if time.time() - idle_since >= settle:
                return
        if timeout and time.time() - started > timeout:
            raise TimeoutError(f'Still busy after {timeout}s; nothing was restarted')
        time.sleep(poll)


def restart_plan(host_mode, restart_host=False, wait=False):
    """What a deploy must do for a server in this host_mode ('split', 'in-process', or None for servers that predate the agent host)."""
    split = host_mode == 'split'
    return {'wait': bool(wait or restart_host or not split), 'stop_host': bool(restart_host and split), 'kill_tree': not split}


def stop_host(state_dir):
    """Ask the agent host to stop through studio.py --stop-host (it refuses while anything is working)."""
    out = subprocess.run([sys.executable, str(app_paths.CODE_DIR / 'studio.py'), '--stop-host', '--state-dir', str(state_dir)], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError('The agent host did not stop: ' + (out.stdout + out.stderr).strip())
    return out.stdout.strip()


def restart(port, pid, command_line, kill_tree=True):
    # taskkill /T also ends the process's children. Only an --in-process server owns agents that way; with an
    # agent host the host (started by this server) must survive, so there is no /T.
    subprocess.run(['taskkill', '/PID', str(pid)] + (['/T'] if kill_tree else []) + ['/F'], capture_output=True)
    for _ in range(50):
        try:
            get(port, '/api/live/bootstrap', timeout=1)
            time.sleep(0.2)
        except (urllib.error.URLError, OSError):
            break
    LOGS.mkdir(exist_ok=True)
    package = state_paths.package_context()
    if package:   # started from inside a packaged app (the Claude desktop app): Studio must not inherit its sandbox
        print(f'This deploy runs inside {package}\'s sandbox; starting Studio through Explorer so it runs outside it.', flush=True)
        process = launch_outside_package(command_line)
    else:
        process = launch_direct(command_line)
    for _ in range(60):
        try:
            boot = get(port, '/api/live/bootstrap', timeout=2)
            listing = get(port, '/api/live/list', timeout=5)
            return (process.pid if process else boot.get('pid')), boot, listing
        except (urllib.error.URLError, OSError):
            if process and process.poll() is not None:
                raise RuntimeError(f'The new server exited with code {process.returncode}; see {LOGS / "agent-studio.stderr.log"}')
            time.sleep(0.5)
    raise RuntimeError('The new server did not answer within 30 seconds' + (f'; see {LOGS / "agent-studio.stderr.log"}' if package else ''))


def launch_direct(command_line):
    stdout = open(LOGS / 'agent-studio.stdout.log', 'ab')
    stderr = open(LOGS / 'agent-studio.stderr.log', 'ab')
    flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    breakaway = 0x01000000  # CREATE_BREAKAWAY_FROM_JOB: outlive whatever launched this script
    try:
        return subprocess.Popen(command_line, cwd=str(HERE), stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL,
                                creationflags=flags | breakaway, close_fds=True)
    except OSError:  # the launching job does not allow breakaway
        return subprocess.Popen(command_line, cwd=str(HERE), stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL,
                                creationflags=flags, close_fds=True)


def launcher_texts(command_line, out_log, err_log, run_script, cwd=None):
    """(launcher .cmd, run .cmd). The launcher is what Explorer opens: it starts the run script hidden, and the run script starts
    Studio with its output appended to the two logs. Both run from the user's shell, not as children of the packaged app."""
    cwd = cwd or HERE
    run = '@echo off\r\ncd /d "%s"\r\n%s >>"%s" 2>>"%s" <nul\r\n' % (cwd, command_line, out_log, err_log)
    launcher = ('@echo off\r\npowershell -NoProfile -NonInteractive -WindowStyle Hidden -Command '
                '"Start-Process -FilePath \'%s\' -WindowStyle Hidden"\r\n') % str(run_script).replace("'", "''")
    return launcher, run


def launch_outside_package(command_line):
    """Start Studio through explorer.exe running a one-shot .cmd. Measured (docs/DESKTOP.md): a process started this way reports no
    package and writes to the real %LOCALAPPDATA%, while Popen, `cmd /c start` and every other child of the packaged app inherit the
    redirection. (A one-shot scheduled task also works; Explorer needs no registered task.) Returns None: Explorer's own process ends at once."""
    out_log, err_log = LOGS / 'agent-studio.stdout.log', LOGS / 'agent-studio.stderr.log'
    launcher, run = LOGS / 'agent-studio-launch.cmd', LOGS / 'agent-studio-run.cmd'
    launcher_text, run_text = launcher_texts(command_line, out_log, err_log, run)
    run.write_text(run_text, encoding='ascii', errors='replace', newline='')
    launcher.write_text(launcher_text, encoding='ascii', errors='replace', newline='')
    subprocess.Popen(['explorer.exe', str(launcher)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    return None


def worktree_refusal(root=None):
    """The message to refuse with when `root` (default: this checkout) is a git worktree, else None."""
    if state_paths.is_worktree_checkout(APP_ROOT if root is None else root):
        return 'deploy.py must run from the main checkout, not a worktree'
    return None


def main(root=None):
    refusal = worktree_refusal(root)
    if refusal:
        sys.exit(refusal)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--settle', type=int, default=15, help='seconds it must stay idle before restarting (default 15)')
    parser.add_argument('--timeout', type=int, default=0, help='give up after this many seconds (default: wait indefinitely)')
    parser.add_argument('--host', action='store_true', help='also restart the agent host (waits until idle, stops the host, then restarts the web server, which starts a new host)')
    parser.add_argument('--wait', action='store_true', help='wait until idle before restarting the web server even though its agents would not be affected')
    parser.add_argument('--dry-run', action='store_true', help='report what would happen; change nothing')
    args = parser.parse_args()
    if os.name != 'nt':
        sys.exit('deploy.py currently supports Windows only')
    try:
        pid, boot = find_pid(args.port)
        command_line = command_line_of(pid)
        plan = restart_plan(boot.get('hostMode'), args.host, args.wait)
        if args.host and boot.get('hostMode') != 'split':
            print('This server runs its agents itself (no agent host), so restarting it is the restart; --host adds nothing.')
        print(f'Studio on port {args.port}: process {pid} ({boot.get("hostMode") or "no agent host"})\n  {command_line}', flush=True)
        if args.dry_run:
            reasons = busy_reasons(get(args.port, '/api/live/list'))
            steps = (['wait until idle'] if plan['wait'] else []) + (['stop the agent host'] if plan['stop_host'] else []) + ['restart the web server']
            print('Would: ' + ', then '.join(steps) + '.')
            if plan['wait']:
                print('Waiting for: ' + '; '.join(reasons) if reasons else 'Idle now.')
            return
        if plan['wait']:
            wait_until_idle(args.port, args.settle, args.timeout)
        if plan['stop_host']:
            print(stop_host(boot.get('stateDir')), flush=True)
        new_pid, new_boot, listing = restart(args.port, pid, command_line, plan['kill_tree'])
        recovered = [f"{r.get('provider')} in {r.get('cwd')}" for r in listing.get('recovered', [])]
        live = [f"{c.get('provider')} in {c.get('cwd')}" for c in listing.get('connections', []) if not c.get('closed')]
        print(f'Restarted: process {new_pid}, instance {new_boot.get("instanceId")}')
        try:
            inside = get(args.port, '/api/live/settings').get('packageContext')
        except (urllib.error.URLError, OSError, ValueError):
            inside = None
        if inside:
            print(f'WARNING: the new Studio still runs inside {inside}\'s sandbox, so its data is in that app\'s private folder.')
        print('Still running: ' + ('; '.join(live) if live else 'none'))
        print(('Reconnecting automatically: ' if listing.get('autoReconnect') else 'Ready to reconnect: ') + ('; '.join(recovered) if recovered else 'none'))
    except (RuntimeError, TimeoutError, urllib.error.URLError, OSError) as error:
        sys.exit(f'Not restarted: {error}')


if __name__ == '__main__':
    main()
