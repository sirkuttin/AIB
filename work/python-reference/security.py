"""Small checks shared by every Studio request path: token comparison and network-path refusal."""
import logging
import os
import secrets

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)


# ---- unread request bodies -------------------------------------------------------------------------------------
DRAIN_LIMIT = 8 * 1024 * 1024   # the most unread body a response will read first; a larger one is not read at all and the connection is closed


class _CountingReader:
    """Wraps a handler's rfile and counts what read() takes, so the response path knows how much of the body is still unread."""
    def __init__(self, raw):
        self._raw = raw
        self.read_bytes = 0

    def read(self, size=-1):
        data = self._raw.read(size)
        self.read_bytes += len(data)
        return data

    def __getattr__(self, name):
        return getattr(self._raw, name)


class BodyDrainMixin:
    """For a BaseHTTPRequestHandler: before any response (refusals and errors included) the unread rest of the request body
    is read and dropped. Closing a socket that still holds unread data makes Windows send a TCP RST, and the client then
    loses the response it was sent. A body over DRAIN_LIMIT is not read: the response says Connection: close instead."""
    def setup(self):
        super().setup()
        self.rfile = _CountingReader(self.rfile)

    def send_response(self, code, message=None):
        close = False
        try:
            length = int(self.headers.get('Content-Length', '0') or 0) if self.headers is not None else 0
        except (ValueError, TypeError):
            length = 0
        if length > 0:
            left = length - getattr(self.rfile, 'read_bytes', length)
            if left > DRAIN_LIMIT:
                close = True
            else:
                try:
                    while left > 0:
                        chunk = self.rfile.read(min(left, 65536))
                        if not chunk:
                            break
                        left -= len(chunk)
                except OSError:
                    pass
        super().send_response(code, message)
        if close:
            self.send_header('Connection', 'close')


def token_matches(supplied, expected):
    """Constant-time token/key comparison that never raises. Header text can hold non-ASCII characters, and
    secrets.compare_digest(str, str) raises TypeError for those, so both sides are compared as UTF-8 bytes."""
    if not isinstance(supplied, (str, bytes)) or not isinstance(expected, (str, bytes)) or not expected:
        return False
    left = supplied if isinstance(supplied, bytes) else supplied.encode('utf-8', 'surrogatepass')
    right = expected if isinstance(expected, bytes) else expected.encode('utf-8', 'surrogatepass')
    return secrets.compare_digest(left, right)


TOKEN_HEADER = 'X-Studio-Token'
ARTIFACT_KEY_HEADER = 'X-Studio-Artifact-Key'
IMAGE_PATH = '/api/transcript/image'

# ---- one auth gate ---------------------------------------------------------------------------------------------
# Every route in studio.py and monitor.py is declared in a RouteTable with the scope it needs. authorize() decides who
# is asking (a Principal) and refuses the request when that principal lacks the scope. Principal kinds:
#   page        the Studio page in a browser (or the desktop window): X-Studio-Token, Host and Origin of this server,
#               Fetch Metadata same-origin or absent, no navigation on /api/, POSTs only with an Origin or same-origin.
#   agent_tool  the artifact MCP shim (urllib, no browser): X-Studio-Artifact-Key valid for one conversation, and no
#               Origin or Sec-Fetch-* headers (a browser must never be able to use a key).
#   host_rpc    the agent host's own socket with its own token and peer check (agent_host.py); not routed through here.
# A later remote mode adds one more principal kind here.
PAGE, AGENT_TOOL, HOST_RPC = 'page', 'agent_tool', 'host_rpc'

SCOPE_STATIC = 'static'            # page files; no token (a browser navigation or bookmark may load them)
SCOPE_BOOTSTRAP = 'bootstrap'      # hands the page its token
SCOPE_IMAGE = 'image'              # <img> loads of transcript pictures; cannot send headers
SCOPE_READ = 'read'
SCOPE_WRITE = 'write'
SCOPE_ARTIFACTS_READ = 'artifacts.read'
SCOPE_ARTIFACTS_WRITE = 'artifacts.write'
SCOPE_ARTIFACTS_TOOL = 'artifacts.tool'   # publish and list: also open to the agent tool key
SCOPE_WORKTREE_TOOL = 'worktree.tool'   # merge_into_project and resolve_edit_clash: also open to the agent tool key
SCOPE_SHUTDOWN = 'shutdown'
PAGE_SCOPES = frozenset({SCOPE_STATIC, SCOPE_BOOTSTRAP, SCOPE_IMAGE, SCOPE_READ, SCOPE_WRITE, SCOPE_ARTIFACTS_READ,
                         SCOPE_ARTIFACTS_WRITE, SCOPE_ARTIFACTS_TOOL, SCOPE_WORKTREE_TOOL, SCOPE_SHUTDOWN})
TOOL_SCOPES = frozenset({SCOPE_ARTIFACTS_TOOL, SCOPE_WORKTREE_TOOL})
TOKENLESS_SCOPES = frozenset({SCOPE_STATIC, SCOPE_BOOTSTRAP})


class Principal:
    def __init__(self, kind, scopes, conversation=None):
        self.kind, self.scopes, self.conversation = kind, frozenset(scopes), conversation

    def __repr__(self):
        return f'Principal({self.kind!r}, {sorted(self.scopes)!r})'


class RouteTable:
    """(METHOD, path) -> scope. Paths outside /api/ are page files (scope 'static') unless listed. Unknown /api/ routes are refused."""

    def __init__(self):
        self.scopes = {}

    def add(self, method, path, scope, *more_paths):
        for item in (path,) + more_paths:
            self.scopes[(method.upper(), item)] = scope
        return self

    def update(self, other):
        self.scopes.update(other.scopes)
        return self

    def scope_for(self, method, path):
        method = 'GET' if method.upper() == 'HEAD' else method.upper()
        found = self.scopes.get((method, path))
        if found is None and not path.startswith('/api/') and method == 'GET':
            return SCOPE_STATIC
        return found


def loopback_name(name):
    """True for 'localhost' and loopback IP literals (127.x.x.x, ::1, with or without brackets)."""
    import ipaddress
    text = str(name or '').strip().lower().strip('[]')
    if text == 'localhost':
        return True
    try:
        return ipaddress.ip_address(text).is_loopback
    except ValueError:
        return False


class Gate:
    """Allowed hosts and origins for one web server. Names are loopback only; ports are this server's own. The artifact
    origin (another port on the same host, same-site) is hard-denied even when someone lists it."""

    DEFAULT_NAMES = ('127.0.0.1', 'localhost')

    def __init__(self, port, token_getter, names=None, origins=(), artifact_ports=()):
        self.port, self.token_getter = port, token_getter
        configured = names if names is not None else [n for n in os.environ.get('STUDIO_ALLOWED_HOSTS', '').split(',') if n.strip()]
        self.names = tuple(dict.fromkeys(n.strip().lower().strip('[]') for n in (list(self.DEFAULT_NAMES) + list(configured)) if loopback_name(n)))
        self.extra_origins = tuple(o for o in (origins or ()) if self._origin_port(o) is not None)
        self.artifact_ports = set(artifact_ports)

    @staticmethod
    def _origin_port(origin):
        import urllib.parse
        try:
            parsed = urllib.parse.urlparse(str(origin))
            if parsed.scheme != 'http' or not loopback_name(parsed.hostname) or parsed.path not in ('', '/') or parsed.port is None:
                return None
            return parsed.port
        except ValueError:
            return None

    def _bracket(self, name):
        return f'[{name}]' if ':' in name else name

    def hosts(self):
        return {f'{self._bracket(n)}:{self.port}' for n in self.names} - self._artifact_hosts()

    def _artifact_hosts(self):
        return {f'{self._bracket(n)}:{p}' for n in self.names for p in self.artifact_ports}

    def origins(self):
        found = {'http://' + h for h in self.hosts()} | {o.rstrip('/') for o in self.extra_origins}
        return {o for o in found if self._origin_port(o) not in self.artifact_ports}

    def allows_host(self, host):
        return host in self.hosts()

    def allows_origin(self, origin):
        return origin in self.origins()


class Refusal:
    """Why authorize said no. Falsy, so `if not authorize(...)` keeps working; `.status` and `.message(path)` are what to answer."""
    REASONS = {
        'unknown_route': (404, 'Not found'),
        'bad_host': (403, 'Not an AIB address'),
        'bad_origin': (403, 'Request must come from the AIB page'),
        'bad_token': (403, 'Invalid local session token'),
        'bad_key': (403, 'Invalid artifact key'),
    }

    def __init__(self, reason):
        self.reason = reason

    def __bool__(self):
        return False

    @property
    def status(self):
        return self.REASONS[self.reason][0]

    def message(self, path=''):
        if self.reason != 'unknown_route' and not str(path).startswith('/api/'):
            return 'Local same-origin access only'   # page files keep their one plain message
        return self.REASONS[self.reason][1]

    def __repr__(self):
        return f'Refusal({self.reason!r})'


def _page_reason(headers, gate, method, path, scope):
    """The checks that identify a Studio page: Host, Origin, Fetch Metadata, and (for POST) a provable same-origin.
    None when they pass, else the refusal reason."""
    if not gate.allows_host(headers.get('Host')):
        return 'bad_host'
    origin = headers.get('Origin')
    if origin is not None and not gate.allows_origin(origin):
        return 'bad_origin'
    site = headers.get('Sec-Fetch-Site')
    if path.startswith('/api/'):
        # same-origin, or no metadata at all (a script, not a browser); never a link click or the artifact origin (same-site).
        if site not in (None, 'same-origin') or headers.get('Sec-Fetch-Mode') == 'navigate':
            return 'bad_origin'
    elif site not in (None, 'none', 'same-origin'):   # page files also accept a typed address or bookmark
        return 'bad_origin'
    if method == 'POST' and origin is None and site != 'same-origin':
        return 'bad_origin'   # a missing Origin used to count as same-origin; for the page it no longer does
    return None


def _tool_reason(headers, gate):
    if not gate.allows_host(headers.get('Host')):
        return 'bad_host'
    if headers.get('Origin') is not None or any(str(name).lower().startswith('sec-fetch-') for name in headers.keys()):
        return 'bad_origin'
    return None


def authorize(handler, route, conversation_id=None):
    """Who is making this request, and may they use this route? `route` is the route's scope from a RouteTable (None for
    an unknown route). Returns a Principal, or a falsy Refusal saying why. conversation_id is what an agent-tool key must be valid for."""
    result = _decide(handler, route, conversation_id)
    if not result:
        try:   # method, path (no query) and reason only: never a header value
            log.info('Refused %s %s: %s', handler.command.upper(), handler.path.split('?', 1)[0], result.reason)
        except Exception:
            pass
    return result


def _decide(handler, route, conversation_id):
    scope = route
    gate = getattr(handler.server, 'gate', None)
    if scope is None:
        return Refusal('unknown_route')
    if gate is None:
        return Refusal('bad_host')
    headers, method = handler.headers, handler.command.upper()
    path = handler.path.split('?', 1)[0]
    key = headers.get(ARTIFACT_KEY_HEADER)
    if key is not None and scope in TOOL_SCOPES:   # an artifact key is only ever treated as the tool, never as the page
        if scope not in TOOL_SCOPES:
            return Refusal('bad_key')
        reason = _tool_reason(headers, gate)
        if reason:
            return Refusal(reason)
        if not isinstance(conversation_id, str) or not conversation_id:
            return Refusal('bad_key')
        try:
            import artifact_keys
            valid = artifact_keys.check(key, conversation_id)
        except Exception:   # a missing or unreadable secret means no
            log.exception('Artifact key check failed; treated as not valid')
            valid = False
        return Principal(AGENT_TOOL, TOOL_SCOPES, conversation_id) if valid else Refusal('bad_key')
    if key is not None:
        return Refusal('bad_key')   # a key is only ever good for the artifact tool route
    if scope not in PAGE_SCOPES:
        return Refusal('unknown_route')
    reason = _page_reason(headers, gate, method, path, scope)
    if reason:
        return Refusal(reason)
    token_ok = token_matches(headers.get(TOKEN_HEADER, ''), gate.token_getter())
    if scope == SCOPE_IMAGE:   # an <img> cannot send the token; the browser marks its loads same-origin + image (navigations and fetches never are)
        if not token_ok and not (headers.get('Sec-Fetch-Site') == 'same-origin' and headers.get('Sec-Fetch-Dest') == 'image'):
            return Refusal('bad_token')
    elif scope not in TOKENLESS_SCOPES and not token_ok:
        return Refusal('bad_token')
    return Principal(PAGE, PAGE_SCOPES)


def install_shutdown_signals(server):
    """SIGINT-like shutdown for the web server on SIGTERM and SIGBREAK: stop serve_forever from another thread so the
    normal close path runs. This never touches the agent host (RemoteStudio.close only detaches). Returns the signals set."""
    import signal
    import threading

    def handler(*_):
        threading.Thread(target=server.shutdown, daemon=True, name='signal-shutdown').start()
    installed = []
    for name in ('SIGTERM', 'SIGBREAK'):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), handler)
                installed.append(name)
            except (ValueError, OSError):   # not the main thread
                pass
    return installed


def is_network_path(value):
    """True for UNC and device paths: \\\\server\\share, //server/share, \\\\?\\C:\\..., \\\\.\\device. Opening one makes
    Windows authenticate to that server (an NTLM hash leak), so no request path may touch the filesystem with it."""
    text = value.strip() if isinstance(value, str) else ''
    return text.startswith(('\\\\', '//', '\\/', '/\\'))


def refuse_network_path(value, what='path'):
    """Raise ValueError when a request-supplied path is a UNC or device path; otherwise return it unchanged."""
    if is_network_path(value):
        raise ValueError('Network and device paths are not supported')
    return value
