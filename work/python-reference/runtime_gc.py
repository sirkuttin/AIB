"""Housekeeping for the desktop app's versioned runtime folders: <data>/runtime/<version>/{python,app}.

The app copies its Python and code there on first run and always starts from there. An update brings a new version folder;
the old one is deleted once no agent host runs from it. Only stdlib and host_client; never touches anything outside <data>/runtime.
"""
import os
import pathlib
import shutil

import host_client

RUNTIME_DIR = 'runtime'


def current_runtime(app_root=None):
    """The <data>/runtime/<version> folder this process runs from, or None (a checkout, not the desktop app)."""
    app = pathlib.Path(app_root or host_client.APP_ROOT)
    version_dir = app.parent
    return version_dir if version_dir.parent.name == RUNTIME_DIR and app.name == 'app' else None


def _inside(path, root):
    path, root = os.path.normcase(os.path.abspath(str(path))), os.path.normcase(os.path.abspath(str(root)))
    return path == root or path.startswith(root + os.sep)


def in_use(state_dir, version_dir):
    """True when the agent host of this state folder is alive and runs code from version_dir."""
    info = host_client.read_info(state_dir)
    return bool(info and info.get('codeRoot') and _inside(info['codeRoot'], version_dir) and host_client.pid_alive(info.get('pid')))


def collect(state_dir, keep, remover=None):
    """Delete every other version folder under <state_dir>/runtime that no host uses. Returns the folders removed."""
    base = pathlib.Path(state_dir) / RUNTIME_DIR
    removed = []
    if not base.is_dir():
        return removed
    keep = os.path.normcase(os.path.abspath(str(keep))) if keep else None
    for entry in sorted(base.iterdir()):
        if not entry.is_dir() or os.path.normcase(os.path.abspath(str(entry))) == keep or in_use(state_dir, entry):
            continue
        try:
            (remover or shutil.rmtree)(entry)
            removed.append(str(entry))
        except OSError:
            pass   # a locked file: the next start tries again
    return removed
