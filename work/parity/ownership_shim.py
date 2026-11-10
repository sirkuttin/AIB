"""Plain-data wrappers around ownership.py and ownership_probe.py for the Deno parity tests (work/deno/ownership_test.ts,
ownership_probe_test.ts). Every folder is a temp folder the Deno test passes in; nothing here looks at real sessions or the real
owners folder. Leases and registries are kept in this process between calls so the Deno side can test exclusion against them."""
import os
import socket
import types

import ownership
import ownership_probe as op

_leases = {}
_registries = {}


# --- leases ---------------------------------------------------------------------------------------
def lease_path(state_dir, provider, session_id):
    return str(ownership.SessionLease(state_dir, provider, session_id).path)


def hold_lease(state_dir, provider, session_id):
    """Take the lease and keep it until release_leases(); 'conflict' when someone else holds it."""
    lease = ownership.SessionLease(state_dir, provider, session_id)
    try:
        lease.acquire()
    except ownership.OwnershipConflict as error:
        return {'conflict': str(error)}
    _leases[(state_dir, provider, session_id)] = lease
    return {'held': str(lease.path)}


def try_lease(state_dir, provider, session_id, create=True):
    """Take and release at once: 'ok', or the OwnershipConflict message."""
    lease = ownership.SessionLease(state_dir, provider, session_id)
    try:
        lease.acquire(create=create)
    except ownership.OwnershipConflict as error:
        return {'conflict': str(error)}
    lease.release()
    return {'ok': True}


def try_lease_at(path):
    lease = ownership.SessionLease.at_path(path)
    try:
        lease.acquire(create=False)
    except ownership.OwnershipConflict:
        return 'conflict'
    lease.release()
    return 'ok'


def release_leases():
    for lease in _leases.values():
        lease.release()
    _leases.clear()
    return True


# --- registry -------------------------------------------------------------------------------------
def registry_announce(directory, instance_id, provider, session_id, cwd='', state='ready'):
    registry = _registries.setdefault((directory, instance_id), op.OwnerRegistry(directory, instance_id=instance_id, client_name='python-peer'))
    return registry.announce(provider, session_id, cwd, state)


def registry_withdraw(directory, instance_id, provider, session_id):
    _registries[(directory, instance_id)].withdraw(provider, session_id)
    return True


def registry_read(directory, instance_id, provider=None, session_id=None):
    entries, problems = op.OwnerRegistry(directory, instance_id=instance_id).read(provider, session_id)
    return {'entries': entries, 'problems': problems}


def identity():
    return {'pid': os.getpid(), 'hostname': socket.gethostname(), 'start': op.process_start_time(os.getpid())}


# --- ps parsing -----------------------------------------------------------------------------------
def fetch_ps(names, commands, fail_first=None, fail_second=None, code=0):
    """fetch_processes_ps with a fake ps: fail_* is 'missing' / 'timeout' to make that call raise. Returns the list or the error."""
    import subprocess

    def run(argv, **kwargs):
        columns = argv[-1]
        first = columns == 'pid=,ppid=,comm='
        fail = fail_first if first else fail_second
        if fail == 'missing':
            raise FileNotFoundError('ps')
        if fail == 'timeout':
            raise subprocess.TimeoutExpired(argv, 8)
        return types.SimpleNamespace(returncode=code if first else 0, stdout=(names if first else commands).encode())
    try:
        return {'ok': op.fetch_processes_ps(run=run)}
    except OSError as error:
        return {'error': type(error).__name__, 'message': str(error)}


# --- the probe ------------------------------------------------------------------------------------
def run_probe(fixture):
    """Build an OwnershipProbe from plain data and run the listed steps against it.

    fixture: omp, claude, owners (folders or None), now (fixed clock), processes (list of {pid, ppid, name, cmdline, cwd}, or
    {'error': text} for a failing list, or 'real' for the real process list), holders (list of [pid, name], None = unavailable,
    'real' = the Restart Manager), studio_owned [[provider, session]], own_pids [int], inspect (bool), instance_id, steps:
    [{'assess': [provider, session], cwd, deep, skip_cmdline, fresh, project_root} | {'released': [provider, session]} |
     {'hints': true} | {'certainty': true} | {'advance': seconds} | {'get': true}]."""
    clock_now = [fixture.get('now')]
    clock = (lambda: clock_now[0]) if clock_now[0] is not None else None
    kwargs = {}
    if clock:
        kwargs['clock'] = clock
    registry = None
    if fixture.get('owners'):
        registry = op.OwnerRegistry(fixture['owners'], instance_id=fixture.get('instance_id', 'mine'), **({'clock': clock} if clock else {}))
    processes = fixture.get('processes', [])
    if processes == 'real':
        source = op.ProcessSource(**({'clock': clock} if clock else {}))
    else:
        def fetch():
            if isinstance(processes, dict):
                raise OSError(processes['error'])
            return [dict(p) for p in processes]
        source = op.ProcessSource(fetch, **({'clock': clock} if clock else {}))
    holders = fixture.get('holders', [])
    if holders == 'real':
        lock_probe = op.restart_manager_holders
    else:
        lock_probe = lambda path: None if holders is None else [tuple(h) for h in holders]  # noqa: E731
    owned = {tuple(x) for x in fixture.get('studio_owned', [])}
    own_pids = list(fixture.get('own_pids', []))
    probe = op.OwnershipProbe(fixture.get('omp'), fixture.get('claude'), registry, source, owned_by_studio=lambda p, s: (p, s) in owned,
                              own_pids=lambda: own_pids, lock_probe=lock_probe, inspect_processes=fixture.get('inspect', True), **kwargs)
    out = []
    for step in fixture.get('steps', []):
        if 'assess' in step:
            provider, session = step['assess']
            result = probe.assess(provider, session, step.get('cwd'), deep=step.get('deep', True), skip_cmdline=step.get('skip_cmdline', False),
                                  fresh=step.get('fresh', False), project_root=step.get('project_root'))
            result.pop('elapsedMs', None)
            out.append(result)
        elif 'released' in step:
            probe.note_released(*step['released'])
            out.append(None)
        elif 'hints' in step:
            out.append(probe.hints())
        elif 'certainty' in step:
            out.append(probe.list_certainty())
        elif 'advance' in step:
            clock_now[0] += step['advance']
            out.append(None)
        elif 'get' in step:
            out.append(source.get()[1])
        elif 'touch' in step:
            path, size, age = step['touch']
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write('x' * size)
            os.utime(path, (clock_now[0] - age, clock_now[0] - age))
            out.append(None)
    return {'steps': out, 'fetches': source.fetches}
