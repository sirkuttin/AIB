"""One-time, restartable move of Agent Studio's data into the private per-user folder (see state_paths.py).

migrate(source, target) either finishes completely or leaves the target untouched:

  1. Preconditions. The old agent host (pid in source/agent-host.json) and any old web server (pid in source/artifact-web.json)
     must be gone, and every lease in source/session-leases/ must be acquirable. Leases are OS byte-range locks: they are only
     probed (and held during the copy so nobody can start a conversation meanwhile), never copied or read.
     If a precondition fails nothing is copied and the result says state 'waiting'; the caller runs on the OLD folder this
     time and tries again at the next start.
  2. Copy into <target>.tmp-<pid>: every top-level studio-* file (settings, conversations, projects, folders, recovery and
     queue files, ...), artifacts/ and artifact-key-secret, byte for byte. agent-host.json, agent-host.log* and
     artifact-web.json are skipped. Absolute references to the old folder inside the copied JSON are rewritten to the new one.
  3. Verify every file (size and sha256 against what was read, and the source again so a change during the copy aborts).
  4. Write .migrated inside the copy, rename the copy into place (the commit), then write MIGRATED-TO.txt in the old folder.
     That note is the only change ever made to the old folder.

A kill at any point before step 4's rename leaves no .migrated in the target, so the next start simply redoes it; leftover
<target>.tmp-<pid> folders of dead processes are removed (only ones carrying our .migrating mark).
"""
import hashlib
import json
import logging
import os
import pathlib
import re
import shutil
import sys
import time

import host_client
import state_paths
from ownership import OwnershipConflict, SessionLease

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

NOTE_NAME = 'MIGRATED-TO.txt'
TMP_MARK = '.migrating'
SKIP_EXACT = {'agent-host.json', 'artifact-web.json'}
SKIP_PREFIX = ('agent-host.log',)
KEEP_EXACT = ('artifact-key-secret',)
COPY_DIRS = ('artifacts', 'agents')   # agents/: Studio-installed adapters


class MigrationAborted(Exception):
    def __init__(self, state, reason):
        super().__init__(reason)
        self.state, self.reason = state, reason


def _result(state, reason='', source=None, **extra):
    return dict({'state': state, 'reason': reason, 'source': str(source) if source else None}, **extra)


def _read_pid(path):
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    pid = data.get('pid') if isinstance(data, dict) else None
    return pid if isinstance(pid, int) else None


def acquire_all_leases(source):
    """Hold every lease in source/session-leases. Returns the held leases; raises MigrationAborted('waiting') when one is taken."""
    held = []
    folder = pathlib.Path(source) / 'session-leases'
    try:
        names = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix == '.lock') if folder.is_dir() else []
    except OSError as error:
        raise MigrationAborted('waiting', f'the lease folder cannot be read ({error})')
    for path in names:
        try:
            held.append(SessionLease.at_path(path).acquire(create=False))
        except OwnershipConflict as error:
            for lease in held:
                lease.release()
            raise MigrationAborted('waiting', 'a conversation lease in the old folder is still held by another process (an agent is running there)') from error
    return held


def check_processes(source):
    host_pid = _read_pid(pathlib.Path(source) / host_client.INFO_NAME)
    if host_pid and host_client.pid_alive(host_pid):
        raise MigrationAborted('waiting', f'the old agent host (process {host_pid}) is still running; stop it with --stop-host first')
    web_pid = _read_pid(pathlib.Path(source) / 'artifact-web.json')
    if web_pid and web_pid != os.getpid() and host_client.pid_alive(web_pid):
        raise MigrationAborted('waiting', f'the old web server (process {web_pid}) is still running')


def plan_files(source):
    """[(relative path, absolute source path)] to copy, plus the names deliberately left behind."""
    source = pathlib.Path(source)
    files, left = [], []
    for entry in sorted(source.iterdir()):
        name = entry.name
        if entry.is_dir():
            if name in COPY_DIRS:
                for base, dirs, names in os.walk(entry):
                    dirs.sort()
                    for item in sorted(names):
                        if item.startswith('.') and item.endswith('.tmp'):
                            continue   # a half-written temp file of the old process
                        full = pathlib.Path(base) / item
                        files.append((full.relative_to(source).as_posix(), full))
            else:
                left.append(name + '/')
            continue
        if name in SKIP_EXACT or name.startswith(SKIP_PREFIX) or name in (NOTE_NAME, state_paths.MIGRATED_MARKER):
            continue
        if name.startswith('.') and name.endswith('.tmp'):
            continue
        if name.startswith('studio-') or name in KEEP_EXACT:
            files.append((name, entry))
        else:
            left.append(name)
    return files, left


_STYLES = (lambda p: p, lambda p: p.replace(chr(92), '/'), lambda p: p.replace(chr(92), chr(92) * 2), lambda p: p.replace(chr(92), '/').replace('/', chr(92) + '/'))


def _rewrite(data, source, target):
    """Replace absolute references to the old folder (plain, forward-slash and JSON-escaped spellings) by the new one. Returns (data, count)."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return data, 0
    count = 0
    for style in _STYLES:
        old, new = style(str(source)), style(str(target))
        text, replaced = re.compile(re.escape(old), re.IGNORECASE if os.name == 'nt' else 0).subn(lambda _m, n=new: n, text)
        count += replaced
    return (text.encode('utf-8'), count) if count else (data, 0)


def _sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def _clean_stale_tmp(target):
    """Remove leftover copies of dead migrations next to the target (only folders carrying our mark)."""
    parent, prefix = target.parent, target.name + '.tmp-'
    try:
        candidates = [p for p in parent.iterdir() if p.is_dir() and p.name.startswith(prefix)]
    except OSError:
        return
    for folder in candidates:
        suffix = folder.name[len(prefix):]
        if not (folder / TMP_MARK).exists():
            continue
        pid = int(suffix) if suffix.isdigit() else None
        if pid == os.getpid() or not host_client.pid_alive(pid):
            shutil.rmtree(folder, ignore_errors=True)


def _copy(source, target, files, on_file, say):
    tmp = target.parent / f'{target.name}.tmp-{os.getpid()}'
    if tmp.exists():
        if not (tmp / TMP_MARK).exists():
            raise MigrationAborted('failed', f'{tmp} exists and is not a leftover of a migration; not touching it')
        shutil.rmtree(tmp)
    state_paths.ensure_private_dir(tmp, strict=False, say=say)
    (tmp / TMP_MARK).write_text(json.dumps({'pid': os.getpid(), 'source': str(source)}), encoding='utf-8')
    expected, rewritten = {}, []
    for relative, path in files:
        data = path.read_bytes()
        source_hash = hashlib.sha256(data).hexdigest()
        out = data
        if relative.endswith('manifest.json') or ('/' not in relative and relative.endswith('.json')):   # never the content of an artifact's own versions
            out, count = _rewrite(data, source, target)
            if count:
                rewritten.append(relative)
                json.loads(out.decode('utf-8'))   # still valid JSON
        destination = tmp / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(out)
        stat = path.stat()
        os.utime(destination, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        expected[relative] = (len(out), hashlib.sha256(out).hexdigest(), source_hash, path)
        if on_file:
            on_file(relative)
    # verify the copy, and that the source did not change while we read it
    for relative, (size, digest, source_hash, path) in expected.items():
        copied = tmp / relative
        if not copied.is_file() or copied.stat().st_size != size or _sha(copied) != digest:
            raise MigrationAborted('failed', f'verification failed for {relative}')
        if relative not in rewritten and digest != source_hash:
            raise MigrationAborted('failed', f'copy of {relative} differs from the source')
        if not path.is_file() or _sha(path) != source_hash:
            raise MigrationAborted('waiting', f'{relative} changed in the old folder while it was being copied (something is still using it)')
    present = {p.relative_to(tmp).as_posix() for p in tmp.rglob('*') if p.is_file()} - {TMP_MARK}
    if present != set(expected):
        raise MigrationAborted('failed', 'the copy holds files that were not planned')
    return tmp, rewritten


def migrate(source, target, say=None, on_file=None):
    """Move source's data into target. Returns {'state': 'done'|'waiting'|'blocked'|'failed', 'reason', 'source', ...}; never raises
    for an expected condition. on_file(relative) is called after each file is copied (tests use it to simulate a kill)."""
    say = say or (lambda message: print(message, flush=True))
    source, target = pathlib.Path(source), pathlib.Path(target)
    if not source.is_dir():
        return _result('none', 'nothing to migrate', source)
    if (target / state_paths.MIGRATED_MARKER).exists():
        return _result('done', 'already migrated', source)
    if target.exists() and any(target.iterdir()):
        return _result('blocked', f'{target} already holds files but was never marked as migrated; move it aside to let AIB migrate', source)
    held = []
    try:
        check_processes(source)
        held = acquire_all_leases(source)
        files, left = plan_files(source)
        _clean_stale_tmp(target)
        say(f'Moving AIB data from {source} to {target} ({len(files)} files)...')
        tmp, rewritten = _copy(source, target, files, on_file, say)
        record = {'version': 1, 'source': str(source), 'at': time.time(), 'atText': time.strftime('%Y-%m-%d %H:%M:%S %z'), 'files': len(files),
                  'rewrittenPaths': rewritten, 'notCopied': left}
        (tmp / state_paths.MIGRATED_MARKER).write_text(json.dumps(record, indent=1), encoding='utf-8')
        (tmp / TMP_MARK).unlink()
        if target.exists():   # an empty folder (checked above); a rename onto it fails on Windows
            target.rmdir()
        try:
            os.replace(tmp, target)
        except OSError:
            if (target / state_paths.MIGRATED_MARKER).exists():   # a second Studio finished first
                shutil.rmtree(tmp, ignore_errors=True)
                return _result('done', 'already migrated', source)
            raise
    except MigrationAborted as aborted:
        return _result(aborted.state, aborted.reason, source)
    except Exception as error:
        log.exception('Data migration from %s failed', source)
        return _result('failed', f'{type(error).__name__}: {error}', source)
    finally:
        for lease in held:
            lease.release()
    try:   # the only change ever made to the old folder
        (source / NOTE_NAME).write_text(
            f'AIB moved this folder\'s data to:\n  {target}\non {record["atText"]}.\n\n'
            'Nothing in this folder was changed or deleted; it is kept as a backup and is no longer used.\n'
            f'To go back to it (rollback), start AIB with: --state-dir "{source}"\n', encoding='utf-8')
    except OSError as error:
        say(f'Note: could not write {NOTE_NAME} in {source}: {error}')
    say(f'AIB data moved to {target}.')
    return _result('done', '', source, files=len(files), rewrittenPaths=rewritten)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Move Agent Studio data from an old state folder into a new one (see the module docstring).')
    parser.add_argument('source', type=pathlib.Path)
    parser.add_argument('target', type=pathlib.Path)
    args = parser.parse_args()
    outcome = migrate(args.source, args.target)
    print(json.dumps(outcome, indent=1))
    sys.exit(0 if outcome['state'] in ('done', 'none') else 2)
