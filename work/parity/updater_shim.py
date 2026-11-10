"""Plain-data wrappers around updater.py for the Deno parity tests (work/deno/updater_test.ts).

Errors come back as {"error": message, "code": code}; the dpkg check and the test base URL are passed as data. service() builds an
UpdateService over a state folder (with a fixed clock) and calls one method, returning its result and the saved state, so the Deno
test can check that both servers read and write the same updates/state.json. The base URL is always a local fake server (or empty
with the placeholder repository, which makes no network call).
"""
import os
from unittest import mock

import updater


def _err(error):
    return {'error': str(error), 'code': error.code, **error.extra}


def installer_kinds(os_name, env, dpkg):
    with mock.patch.object(updater.os.path, 'exists', lambda p: dpkg):
        return list(updater.installer_kinds(os_name, env))


def pick_asset(assets, key, env, dpkg=False):
    with mock.patch.object(updater.os.path, 'exists', lambda p: dpkg):
        return updater.pick_asset(assets, tuple(key) if key else None, env)


def pick_release(releases, current, key, env, dpkg=False):
    with mock.patch.object(updater.os.path, 'exists', lambda p: dpkg):
        try:
            return updater.pick_release(releases, current, tuple(key) if key else None, env)
        except ValueError as error:
            return {'error': str(error), 'code': 'ValueError'}


def checksum_for(text, filename):
    try:
        return updater.checksum_for(text, filename)
    except updater.UpdateError as error:
        return _err(error)


def check_url(url, base=''):
    with mock.patch.dict(os.environ, {updater.BASE_ENV: base}):
        try:
            updater.check_url(url)
            return None
        except updater.UpdateError as error:
            return _err(error)


def service(state_dir, method, args=(), base='', now=1_000_000.0, key=('windows', 'x64'), current='0.1.0-beta.1', env=None,
            repo='acme/aib', busy=0):
    launched = []
    with mock.patch.dict(os.environ, {updater.BASE_ENV: base}):
        svc = updater.UpdateService(state_dir, now=lambda: now, key=tuple(key), current=current, env=env or {}, repo=repo,
                                    busy_chats=lambda: busy, launcher=launched.append, quit_fn=lambda: None)
        try:
            result = getattr(svc, method)(*args) if method else None
        except updater.UpdateError as error:
            result = _err(error)
        return {'result': result, 'state': svc.state, 'status': svc.status(), 'launched': launched}
