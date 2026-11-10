"""Automatic updates, ported from the owner's GROUT updater (ReleaseDock/SelfUpdater.cs): check GitHub Releases, download the installer
for this platform and architecture, verify its SHA-256 against the release's SHA256SUMS asset, tell the person, and install only when
they click.

Rules this file keeps:
  * The only network calls are to the GitHub Releases API (and the asset hosts GitHub redirects to), over https, never with a
    credential, with redirects followed by hand and every hop's host checked. A test points AIB_UPDATE_API_BASE at a local fake server.
  * An installer is never run unless its hash matched the release's SHA256SUMS line for exactly that file name. No line, two lines,
    a different hash: refused, and the file is deleted.
  * Nothing installs without the person's click. Automatic checks only look, download and verify.
  * Checks happen at most once a day (manual "Check for updates" is always allowed). Turned off in Settings: no network call at all.
  * Only Windows installs in place today (NSIS, per-user, silent). Linux and macOS get the verified file and instructions.
"""
import hashlib
import json
import os
import pathlib
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from version import __version__

# The public repository's slug. A placeholder until the public repo exists: while it is the placeholder (and no test base URL is
# set) no network call is made and the page says so.
# The desktop app sets AIB_BUNDLED_PYTHON=1; studio.py removes it from the environment at startup (agents must not inherit it), so
# it is read once here, at import, before that happens.
BUNDLED_AT_START = os.environ.get('AIB_BUNDLED_PYTHON') == '1'
UPDATE_REPO = 'OWNER/aib'
PLACEHOLDER_REPO = 'OWNER/aib'
API_BASE = 'https://api.github.com'
BASE_ENV = 'AIB_UPDATE_API_BASE'        # test hook: a local fake release server (http://127.0.0.1:PORT)
CHECK_INTERVAL = 24 * 3600
MAX_SUMS_BYTES = 64 * 1024
MAX_INSTALLER_BYTES = 600 * 1024 * 1024
MAX_RELEASES_BYTES = 4 * 1024 * 1024
REQUEST_TIMEOUT = 30
TICK_SECONDS = 5
FIRST_CHECK_DELAY = 20
SUMS_NAME = 'SHA256SUMS'
NAME_OK = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}$')


class UpdateError(Exception):
    def __init__(self, message, code='update_failed', **extra):
        super().__init__(message)
        self.code, self.extra = code, extra


# ---- versions -------------------------------------------------------------------------------------------------------
_VERSION = re.compile(r'^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$')


def parse_version(text):
    """'v0.1.0-beta.2' -> (0, 1, 0, ('beta', '2')); None when it is not a semantic version."""
    m = _VERSION.match(str(text or '').strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), tuple(m.group(4).split('.')) if m.group(4) else ()


def _cmp(a, b):
    return (a > b) - (a < b)


def compare(a, b):
    """Semantic-version order: -1, 0 or 1. A pre-release (beta) is older than its release; beta.2 is newer than beta.1 and older than
    beta.10; numbers sort below words."""
    pa, pb = parse_version(a) if isinstance(a, str) else a, parse_version(b) if isinstance(b, str) else b
    if pa is None or pb is None:
        raise ValueError('not a version')
    if pa[:3] != pb[:3]:
        return _cmp(pa[:3], pb[:3])
    if not pa[3] and not pb[3]:
        return 0
    if not pa[3]:
        return 1
    if not pb[3]:
        return -1
    for x, y in zip(pa[3], pb[3]):
        if x == y:
            continue
        xn, yn = x.isdigit(), y.isdigit()
        if xn and yn:
            return _cmp(int(x), int(y))
        if xn != yn:
            return -1 if xn else 1
        return _cmp(x, y)
    return _cmp(len(pa[3]), len(pb[3]))


def is_prerelease(version):
    parsed = parse_version(version)
    return bool(parsed and parsed[3])


# ---- which installer is ours ----------------------------------------------------------------------------------------
def platform_key(system=None, machine=None):
    """('windows'|'linux'|'macos', 'x64'|'arm64') for this machine, or None."""
    system = (system or sys.platform).lower()
    machine = (machine or platform.machine()).lower()
    os_name = 'windows' if system.startswith(('win', 'cygwin')) else 'macos' if system in ('darwin', 'macos') else 'linux' if system.startswith('linux') else None
    arch = 'x64' if machine in ('amd64', 'x86_64', 'x64') else 'arm64' if machine in ('arm64', 'aarch64') else None
    return (os_name, arch) if os_name and arch else None


_ARCH_WORDS = {'x64': ('x64', 'x86_64', 'amd64'), 'arm64': ('arm64', 'aarch64')}


def _arch_of(name):
    words = set(re.split(r'[^a-z0-9]+', name.lower()))
    for arch, aliases in _ARCH_WORDS.items():
        if words & set(aliases):
            return arch
    return None


def installer_kinds(os_name, env=None):
    """File endings that install on this system, best first (Tauri's names: AIB_0.1.0_x64-setup.exe, _amd64.AppImage, _amd64.deb, _aarch64.dmg)."""
    env = os.environ if env is None else env
    if os_name == 'windows':
        return ('-setup.exe',)
    if os_name == 'macos':
        return ('.dmg',)
    if env.get('APPIMAGE') or not (os.path.exists('/usr/bin/dpkg') or os.path.exists('/bin/dpkg')):
        return ('.appimage', '.deb')
    return ('.deb', '.appimage')


def pick_asset(assets, key, env=None):
    """The installer asset for this platform and architecture, or None. Only fully uploaded assets with plain names."""
    if not key:
        return None
    for kind in installer_kinds(key[0], env):
        for a in assets:
            name = str(a.get('name') or '')
            if a.get('state', 'uploaded') == 'uploaded' and NAME_OK.match(name) and name.lower().endswith(kind) and _arch_of(name) == key[1]:
                return a
    return None


def pick_release(releases, current, key, env=None):
    """The newest release worth offering, as a plain dict, or None.
    Drafts are skipped. Pre-releases (beta tags) are offered only to someone already on a pre-release: a stable install is never
    moved onto a beta. A release counts only when its installer for this platform and its SHA256SUMS are both uploaded."""
    want_pre = is_prerelease(current)
    best = None
    for r in releases if isinstance(releases, list) else []:
        if not isinstance(r, dict) or r.get('draft'):
            continue
        tag = str(r.get('tag_name') or '')
        version = parse_version(tag)
        if version is None or (version[3] and not want_pre):
            continue
        if compare(version, current) <= 0:
            continue
        assets = [a for a in (r.get('assets') or []) if isinstance(a, dict)]
        installer = pick_asset(assets, key, env)
        sums = next((a for a in assets if a.get('name') == SUMS_NAME and a.get('state', 'uploaded') == 'uploaded'), None)
        if not installer or not sums or not installer.get('url') or not sums.get('url'):
            continue
        if best is None or compare(version, best['_parsed']) > 0:
            best = {'_parsed': version, 'version': tag.lstrip('v'), 'tag': tag, 'prerelease': bool(version[3]), 'page': str(r.get('html_url') or ''),
                    'installer': {'name': installer['name'], 'url': installer['url'], 'size': int(installer.get('size') or 0)},
                    'sums': {'name': SUMS_NAME, 'url': sums['url']}}
    if best:
        best.pop('_parsed')
    return best


def checksum_for(text, filename):
    """The one SHA-256 line for exactly this file name in a SHA256SUMS text (`<64 hex>  name` or `<64 hex> *name`). Zero or several: refused."""
    found = [m.group(1).lower() for m in (re.match(r'^([A-Fa-f0-9]{64}) [ *]?(.+?)\s*$', line.strip('\r')) for line in text.split('\n')) if m and m.group(2) == filename]
    if len(found) != 1:
        raise UpdateError('The release has no checksum (or an ambiguous one) for ' + filename + ', so it was not trusted.', 'no_checksum')
    return found[0]


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


# ---- network --------------------------------------------------------------------------------------------------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _base():
    override = os.environ.get(BASE_ENV, '').strip().rstrip('/')
    return override or API_BASE, bool(override)


def check_url(url):
    """Refuse any hop that is not GitHub over https (or, in the test hook, the fake server's own host and port)."""
    base, overridden = _base()
    u = urllib.parse.urlsplit(url)
    if u.username or u.password:
        raise UpdateError('Unexpected update host.', 'bad_host')
    if overridden:
        b = urllib.parse.urlsplit(base)
        if (u.scheme, u.hostname, u.port) == (b.scheme, b.hostname, b.port):
            return
        raise UpdateError('Unexpected update host.', 'bad_host')
    host = (u.hostname or '').lower()
    if u.scheme != 'https' or (u.port not in (None, 443)):
        raise UpdateError('Unexpected update host.', 'bad_host')
    if host in ('api.github.com', 'github.com') or host.endswith('.githubusercontent.com'):
        return
    raise UpdateError('Unexpected update host.', 'bad_host')


def http_open(url, accept):
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(6):
        check_url(url)
        request = urllib.request.Request(url, headers={'Accept': accept, 'User-Agent': 'AIB/' + __version__, 'X-GitHub-Api-Version': '2022-11-28'})
        try:
            return opener.open(request, timeout=REQUEST_TIMEOUT)
        except urllib.error.HTTPError as error:
            location = error.headers.get('Location') if error.code in (301, 302, 303, 307, 308) else None
            error.close()
            if not location:
                raise UpdateError(f'GitHub did not answer the update request ({error.code}). Try again later.', 'http_error') from error
            url = urllib.parse.urljoin(url, location)
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise UpdateError('Could not reach GitHub to check for updates.', 'offline') from error
    raise UpdateError('Too many redirects.', 'http_error')


def read_limited(url, accept, limit):
    with http_open(url, accept) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise UpdateError('The update response was larger than expected.', 'too_big')
    return data


def download_to(url, dest, limit):
    """Stream an asset to dest (via a .part file); returns its SHA-256. Refuses a web page where a file should be."""
    with http_open(url, 'application/octet-stream') as response:
        kind = (response.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if kind in ('text/html', 'application/json'):
            raise UpdateError('GitHub returned a page instead of the update file.', 'bad_download')
        part = dest.with_name(dest.name + '.part')
        h, total = hashlib.sha256(), 0
        try:
            with open(part, 'wb') as out:
                for block in iter(lambda: response.read(1 << 16), b''):
                    total += len(block)
                    if total > limit:
                        raise UpdateError('The update file is larger than its limit.', 'too_big')
                    h.update(block)
                    out.write(block)
        except BaseException:
            part.unlink(missing_ok=True)
            raise
    os.replace(part, dest)
    return h.hexdigest()


# ---- the service ----------------------------------------------------------------------------------------------------
class UpdateService:
    """Owns the update state for one Studio web server. All methods are safe to call from request threads.

    state_dir: Studio's data folder (updates live in <state_dir>/updates). auto_check(): the Settings toggle. busy_chats(): how many
    chats are working (an exception counts as 'unknown', which defers the install). quit_fn(): ends this web server so the helper
    can run the installer. launcher(args): starts the detached helper; both are replaced in tests."""

    def __init__(self, state_dir, auto_check=lambda: True, busy_chats=lambda: 0, quit_fn=None, launcher=None, current=__version__,
                 key=None, env=None, now=time.time, repo=None):
        self.root = pathlib.Path(state_dir) / 'updates'
        self.auto_check, self.busy_chats, self.quit_fn = auto_check, busy_chats, quit_fn
        self.launcher = launcher or self._launch_helper
        self.current = current
        self.env = dict(os.environ, **({'AIB_BUNDLED_PYTHON': '1'} if BUNDLED_AT_START else {})) if env is None else env
        self.key = key if key is not None else platform_key()
        self.now = now
        self.repo = repo or UPDATE_REPO
        self.lock = threading.RLock()
        self.checking = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.state = self._load()

    # -- persistence
    def _load(self):
        try:
            data = json.loads((self.root / 'state.json').read_text(encoding='utf-8'))
            if isinstance(data, dict):
                return {'lastCheck': float(data.get('lastCheck') or 0), 'found': data.get('found') if isinstance(data.get('found'), dict) else None,
                        'downloaded': data.get('downloaded') if isinstance(data.get('downloaded'), dict) else None, 'error': str(data.get('error') or ''),
                        'code': str(data.get('code') or ''), 'installWhenIdle': bool(data.get('installWhenIdle'))}
        except (OSError, ValueError):
            pass
        return {'lastCheck': 0.0, 'found': None, 'downloaded': None, 'error': '', 'code': '', 'installWhenIdle': False}

    def _save(self):
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self.root / f'state.json.{os.getpid()}.tmp'
            tmp.write_text(json.dumps(self.state), encoding='utf-8')
            os.replace(tmp, self.root / 'state.json')
        except OSError:
            pass

    # -- what the page shows
    def configured(self):
        return self.repo != PLACEHOLDER_REPO or _base()[1]

    def can_install_in_place(self):
        """Only the installed Windows app (bundled Python, started by the desktop app) can run its own NSIS installer."""
        return bool(self.key and self.key[0] == 'windows' and self.env.get('AIB_APP_ID') == 'dev.aib.app' and self.env.get('AIB_BUNDLED_PYTHON') == '1'
                    and self.env.get('AIB_APP_PID') and self.env.get('AIB_APP_EXE'))

    def _fresh_found(self):
        found = self.state.get('found')
        if found and compare(found['version'], self.current) <= 0:
            return None
        return found

    def instructions(self, path):
        folder = str(pathlib.Path(path).parent)
        if path.lower().endswith('.dmg'):
            return f'Open {path}, drag AIB to Applications, then open it (right-click, Open, the first time).'
        if path.lower().endswith('.deb'):
            return f'Install it with: sudo apt install "{path}"  (or open the file in your software installer). Then start AIB again.'
        if path.lower().endswith('.appimage'):
            return f'Replace your AIB AppImage with {path}, make it executable (chmod +x), and start it.'
        return f'Run {path} (it is in {folder}).'

    def status(self):
        with self.lock:
            found, got = self._fresh_found(), self.state.get('downloaded')
            ready = bool(found and got and got.get('version') == found['version'] and pathlib.Path(got.get('path', '')).is_file())
            out = {'current': self.current, 'autoCheck': bool(self.auto_check()), 'configured': self.configured(), 'checking': self.checking.locked(),
                   'lastCheck': self.state['lastCheck'] or None, 'error': self.state['error'], 'errorCode': self.state['code'],
                   'installWhenIdle': bool(self.state['installWhenIdle']), 'state': 'none', 'platform': list(self.key) if self.key else None,
                   'inPlace': self.can_install_in_place()}
            if self.state['code'] == 'checksum_mismatch' or self.state['code'] == 'no_checksum':
                out['state'] = 'refused'
            elif ready:
                out['state'] = 'ready'
                out['available'] = {'version': found['version'], 'tag': found['tag'], 'prerelease': found.get('prerelease', False), 'page': found['page'],
                                    'name': got['name'], 'path': got['path'], 'sha256': got['sha256']}
                if not out['inPlace']:
                    out['instructions'] = self.instructions(got['path'])
            elif found:
                out['state'] = 'found'
                out['available'] = {'version': found['version'], 'tag': found['tag'], 'prerelease': found.get('prerelease', False), 'page': found['page']}
            elif self.state['error']:
                out['state'] = 'error'
            elif not self.configured():
                out['state'] = 'unconfigured'
            return out

    # -- checking
    def due(self):
        return self.now() - self.state['lastCheck'] >= CHECK_INTERVAL

    def check(self, manual=False):
        """Look for a newer release, download and verify its installer. Automatic checks stop (no network at all) when the setting is
        off, the repository is still the placeholder, or a check already happened in the last day. Returns status()."""
        if not self.configured():
            return self.status()
        if not manual and (not self.auto_check() or not self.due()):
            return self.status()
        if not self.checking.acquire(blocking=False):
            return self.status()
        try:
            with self.lock:
                self.state['lastCheck'] = self.now()   # the attempt counts: a failing network is not retried in a loop
                self.state['error'], self.state['code'] = '', ''
                self._save()
            try:
                found = self._fetch_release()
                with self.lock:
                    self.state['found'] = found
                    self._save()
                if found:
                    self._download(found)
            except UpdateError as error:
                with self.lock:
                    self.state['error'], self.state['code'] = str(error), error.code
                    self._save()
        finally:
            self.checking.release()
        return self.status()

    def _fetch_release(self):
        base, _ = _base()
        url = f'{base}/repos/{self.repo}/releases?per_page=30'
        try:
            releases = json.loads(read_limited(url, 'application/vnd.github+json', MAX_RELEASES_BYTES).decode('utf-8'))
        except ValueError as error:
            raise UpdateError('GitHub sent a release list that could not be read.', 'bad_response') from error
        if not self.key:
            raise UpdateError('This computer is not a platform AIB has installers for.', 'unsupported_platform')
        return pick_release(releases, self.current, self.key, self.env)

    def _download(self, found):
        with self.lock:
            got = self.state.get('downloaded')
        if got and got.get('version') == found['version'] and pathlib.Path(got.get('path', '')).is_file() and file_sha256(got['path']) == got.get('sha256'):
            return
        folder = self.root / found['version']
        folder.mkdir(parents=True, exist_ok=True)
        name = found['installer']['name']
        if not NAME_OK.match(name):
            raise UpdateError('The release names its installer in an unexpected way.', 'bad_name')
        sums = read_limited(found['sums']['url'], 'application/octet-stream', MAX_SUMS_BYTES).decode('utf-8', 'replace')
        want = checksum_for(sums, name)
        dest = folder / name
        have = download_to(found['installer']['url'], dest, MAX_INSTALLER_BYTES)
        if have != want:
            dest.unlink(missing_ok=True)
            raise UpdateError('The downloaded update did not match its published checksum, so it was refused and deleted. Nothing was installed.', 'checksum_mismatch')
        with self.lock:
            self.state['downloaded'] = {'version': found['version'], 'name': name, 'path': str(dest), 'sha256': have}
            self._save()

    # -- installing
    def install(self, when_idle=False):
        """The person clicked Install now (or Install when chats finish). Returns a dict: {state: 'installing'} when the helper is
        running and this server is quitting, {state: 'waiting'} when it will install once no chat is working. Raises UpdateError."""
        with self.lock:
            status = self.status()
            if status['state'] != 'ready':
                raise UpdateError('There is no verified update to install.', 'not_ready')
            if not status['inPlace']:
                raise UpdateError(status.get('instructions') or 'Install it from the downloaded file.', 'manual', path=status['available']['path'])
            if when_idle:
                self.state['installWhenIdle'] = True
                self._save()
        busy = self._busy()
        if busy:
            if when_idle:
                return {'state': 'waiting', 'chats': busy}
            raise UpdateError(f'{busy} chat(s) are working. Install when they finish, or wait.', 'chats_working', chats=busy)
        return self._go()

    def cancel_wait(self):
        with self.lock:
            self.state['installWhenIdle'] = False
            self._save()
        return self.status()

    def _busy(self):
        try:
            return int(self.busy_chats() or 0)
        except Exception:
            return 1   # unknown counts as busy: never install over a chat we cannot see

    def _go(self):
        with self.lock:
            got = self.state.get('downloaded') or {}
            path = got.get('path', '')
            if not path or not pathlib.Path(path).is_file() or file_sha256(path) != got.get('sha256'):
                raise UpdateError('The downloaded update changed or is missing; it was not run.', 'checksum_mismatch')
            self.state['installWhenIdle'] = False
            self._save()
        self.launcher({'installer': path, 'sha256': got['sha256'], 'pid': int(self.env['AIB_APP_PID']), 'exe': self.env['AIB_APP_EXE'],
                       'log': str(self.root / 'install.log'), 'version': got['version']})
        if self.quit_fn:
            self.quit_fn()
        return {'state': 'installing'}

    def _launch_helper(self, args):
        script = pathlib.Path(__file__).with_name('update_helper.py')
        flags = (0x08000000 | 0x00000200) if os.name == 'nt' else 0   # no window, own process group: it outlives this server
        env = {k: v for k, v in os.environ.items() if k != 'PYTHONHOME' and not k.startswith('AIB_') and k != 'AGENT_STUDIO_LAUNCH_NONCE'}
        subprocess.Popen([sys.executable, '-E', '-s', str(script), json.dumps(args)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True, env=env, cwd=tempfile.gettempdir())

    # -- the background loop (not started by tests)
    def start(self):
        if self.thread:
            return
        self.thread = threading.Thread(target=self._loop, daemon=True, name='aib-updater')
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def _loop(self):
        if self.stop_event.wait(FIRST_CHECK_DELAY):
            return
        while True:
            try:
                self.tick()
            except Exception:   # a failed tick must never end the loop
                pass
            if self.stop_event.wait(TICK_SECONDS):
                return

    def tick(self):
        """One pass: an automatic check when one is due, and the install the person asked to wait for once no chat is working."""
        self.check(manual=False)
        with self.lock:
            waiting = self.state['installWhenIdle']
        if waiting and self.status()['state'] == 'ready' and not self._busy():
            self._go()
