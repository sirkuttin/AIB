"""The Studio web server's HTTP handler and its one route table.

ROUTE_SPECS is the single list of every /api/live/ route Studio answers (method, path, security scope, handler).
The security route table (what security.authorize checks) and the handler's dispatch are both built from it, so a
route cannot be served without a scope or scoped without a route. Handlers are plain functions taking the request
handler and a WebContext (the per-server parts: the Studio or RemoteStudio, options, editor launcher, folder memory,
artifact service and store). studio.create_server builds the WebContext and calls make_handler."""
import json
import os
import re
import sys
import threading
import time
import urllib.parse

import artifacts
import editors
import folders
import monitor
import prompts
import security
import updater
import worktree_merge
from app_paths import APP_ROOT
from version import ABOUT_LINE, VERSION_LABEL, __version__
from attachments import MAX_PROMPT_BODY_BYTES
from chat_folders import repo_branch, changes_response
from host_client import HostUnavailable

HERE = APP_ROOT
WEB_STARTED = time.time()

# Page files are served by name pattern rather than a hard-coded list, so a new front-end module needs
# only a browser refresh, not a server restart. Only plain lowercase names of .js/.css files that exist in
# this folder qualify (no subfolders, no dot-files, no traversal); the old monitor dashboard keeps its own
# four files.
_ASSET_NAME = re.compile(r'^/([a-z0-9][a-z0-9-]*\.(?:js|css))$')
_MONITOR_ASSETS = frozenset({'app.js', 'style.css', 'sidebar.js', 'sidebar.css'})


def studio_asset(path):
    """Map a request path to a Studio page file name, or None if Studio does not serve it."""
    if path in ('/', '/chat.html'):
        return 'chat.html'
    match = _ASSET_NAME.match(path or '')
    if not match or match.group(1) in _MONITOR_ASSETS:
        return None
    return match.group(1) if (HERE / match.group(1)).is_file() else None


def model_in_use(state, options):
    """The model the conversation's replies really come from: the newest assistant record of its own transcript, else the
    model the adapter reports on usage updates. None when neither is known (the page then shows only what the agent advertises)."""
    found = None
    try:
        found = monitor.model_in_use(state.get('provider'), state.get('sessionId'), getattr(options, 'claude_projects', None), getattr(options, 'omp_sessions', None))
    except (OSError, ValueError, TypeError):
        found = None
    if found is None:
        reported = (state.get('breadth') or {}).get('responseModel')
        if isinstance(reported, str) and reported:
            found = {'model': reported, 'source': 'agent-usage'}
    return found


class WebContext:
    """What the handlers need from the running server (they are plain functions, not closures)."""

    def __init__(self, studio, options, launcher, folder_memory, artifact_service, artifact_store, routes, updates=None):
        self.studio, self.options, self.launcher, self.folder_memory = studio, options, launcher, folder_memory
        self.updates = updates   # updater.UpdateService (None in tests that do not need it)
        self.artifact_service, self.artifact_store, self.routes = artifact_service, artifact_store, routes


# ---- GET handlers: (handler, ctx, parsed, args) ----

def get_bootstrap(h, ctx, parsed, args):
    studio, options = ctx.studio, ctx.options
    info = studio.live_info()
    return h.respond(200, {'token': studio.token, 'instanceId': info['instanceId'], 'webInstanceId': studio.web_instance_id, 'pid': os.getpid(), 'launchNonce': os.environ.get('AGENT_STUDIO_LAUNCH_NONCE', ''), 'hostMode': studio.host_mode, 'hostPid': info.get('pid'), 'stateDir': str(studio.state_dir), 'artifactOrigin': ctx.artifact_store.origin,
        'server': {'version': __version__, 'versionLabel': VERSION_LABEL, 'aboutLine': ABOUT_LINE, 'protocol': info.get('protocol'), 'hostFormat': info.get('format'), 'hostStartedAt': info.get('startedAt'), 'webStartedAt': WEB_STARTED,
                   'hostAutoReconnect': (info.get('startedWith') or {}).get('autoReconnect'), 'python': sys.version.split()[0], 'webPort': getattr(options, 'port', None)},
        'features': {'promptReceipts': True, 'sessionLeases': True, 'formElicitation': True, 'asyncConnect': True, 'imageAttachments': True, 'fileAttachments': True, 'urlElicitation': True, 'authentication': True, 'setupRequests': True, 'requestWithdrawal': True, 'acpBreadth': True, 'durableRecovery': info.get('durableRecovery', False), 'sessionDiscovery': True, 'subagentCancel': 'when_advertised', 'externalOwnership': 'best_effort', 'ownershipEvidence': True, 'ownerAnnouncements': info.get('ownerAnnouncements', False), 'conversationOrganize': True},
        'connections': info['connections'], **studio.notices(), **({'hostProblem': info['unavailable']} if info.get('unavailable') else {})})


def get_ownership(h, ctx, parsed, args):
    return h.respond(200, ctx.studio.ownership_query(args.get('provider', [''])[0], args.get('id', [''])[0], security.refuse_network_path(args.get('cwd', [''])[0])))


def get_changes(h, ctx, parsed, args):
    return h.respond(*changes_response(ctx.studio, parsed.path, args, h.headers))


def get_branch(h, ctx, parsed, args):
    return h.respond(200, {'branch': repo_branch(args.get('cwd', [''])[0])})


def get_worktree(h, ctx, parsed, args):
    """Stage E: the Merge button's state for a chat."""
    return h.respond(200, worktree_merge.status(ctx.studio, args.get('id', [''])[0]))


def post_worktree_merge(h, ctx, body):
    """Stage E: merge a worktree chat into its base branch (worktree_merge.py)."""
    title = body.get('title') if isinstance(body.get('title'), str) else ''
    try:
        return h.respond(200, worktree_merge.merge(ctx.studio, body.get('id'), title))
    except worktree_merge.Refused as error:
        return h.respond(error.status, {'error': str(error), 'code': error.code})


def get_worktree_clash(h, ctx, parsed, args):
    """Stage E2: the amber line of a project whose re-applied edits clash."""
    return h.respond(200, worktree_merge.clash_status(ctx.studio, args.get('project', [''])[0]))


def post_worktree_clash(h, ctx, body):
    """Stage E2: the buttons in the note ('keep-mine', 'leave'). Stage G2: {project, action: 'resume-sync'} is the Resume of the amber line."""
    if body.get('action') == 'resume-sync':
        import worktree_sync
        return h.respond(200, {'ok': True, 'resumed': worktree_sync.resume(ctx.studio.state_dir, body.get('project'))})
    try:
        return h.respond(200, worktree_merge.resolve_clash(ctx.studio, body.get('id'), body.get('action') if isinstance(body.get('action'), str) else ''))
    except worktree_merge.Refused as error:
        return h.respond(error.status, {'error': str(error), 'code': error.code})


def post_worktree_tool(h, ctx, path):
    """/api/live/worktree/tool: the agent's merge_into_project and resolve_edit_clash. Its key is bound to the body's conversation, and the
    conversation the key proves is the only one that is merged or resolved."""
    try:
        length = int(h.headers.get('Content-Length', '0'))
        if not 0 < length <= 100000:
            raise ValueError('Invalid request size')
        body = json.loads(h.rfile.read(length))
    except (ValueError, TypeError) as error:
        return h.respond(400, {'error': str(error)})
    body = body if isinstance(body, dict) else {}
    conversation = body.get('conversationId')
    allowed = h.gate('POST', path, conversation)
    if not allowed:
        return h.refuse(path, allowed)
    action = body.get('action') if isinstance(body.get('action'), str) else 'merge'
    try:
        if action == 'merge':
            return h.respond(200, worktree_merge.merge(ctx.studio, conversation, '', from_tool=True))
        return h.respond(200, worktree_merge.resolve_clash(ctx.studio, conversation, action, from_tool=True))
    except worktree_merge.Refused as error:
        return h.respond(error.status, {'error': str(error), 'code': error.code})


def get_list(h, ctx, parsed, args):
    studio = ctx.studio
    return h.respond(200, dict(studio.live_list(), conversationRevision=studio.conversations.revision(), projectsRevision=studio.project_prefs.revision(), readStateRevision=studio.read_state.revision(), settingsRevision=studio.settings.revision(), webInstanceId=studio.web_instance_id))


def get_conversation_state(h, ctx, parsed, args):
    return h.respond(200, ctx.studio.conversations.public())


def get_read_state(h, ctx, parsed, args):
    return h.respond(200, ctx.studio.read_state.public())


def post_read_state(h, ctx, body):
    ctx.studio.read_state.update(body)
    return h.respond(200, dict(ctx.studio.read_state.public(), ok=True))


def get_project_prefs(h, ctx, parsed, args):
    return h.respond(200, ctx.studio.project_prefs.public())


def get_editors(h, ctx, parsed, args):
    try:
        return h.respond(200, ctx.launcher.listing(args.get('project', [''])[0] or None))
    except editors.EditorError as error:
        return h.respond(error.status, {'error': str(error), 'code': error.code})


def get_settings(h, ctx, parsed, args):
    return h.respond(200, ctx.studio.settings_view(recheck=args.get('recheck', [''])[0] == '1'))


def get_update(h, ctx, parsed, args):
    return h.respond(200, ctx.updates.status())


def get_folders_check(h, ctx, parsed, args):
    return h.respond(200, folders.check_path(args.get('path', [''])[0]))


def get_folders_kinds(h, ctx, parsed, args):
    wanted = list(args.get('path', []))
    try:   # the page sends one JSON list in `paths`; repeated `path` parameters work too
        extra = json.loads(args.get('paths', ['[]'])[0])
        wanted += extra if isinstance(extra, list) else []
    except ValueError:
        pass
    return h.respond(200, {'kinds': folders.folder_kinds(wanted)})


def get_folders_start(h, ctx, parsed, args):
    return h.respond(200, folders.start_folder(ctx.folder_memory))


def get_state(h, ctx, parsed, args):
    state = ctx.studio.live_state(args.get('id', [''])[0], int(args.get('after', ['0'])[0]))
    if state is None:
        return h.respond(404, {'error': 'This Studio connection is no longer available. Your saved conversation can be continued again.', 'code': 'connection_not_found'})
    return h.respond(200, dict(state, inUse=model_in_use(state, ctx.options)))


def get_prompts(h, ctx, parsed, args):
    """The Prompts view's find box: the user's prompts of a saved chat with their real event indexes (the same indexes
    /api/transcript pages by, so a hit on an older page can be loaded). ?key=<chat key>&q=<text>&thinking=1&limit=<n>."""
    catalog = getattr(h.server, 'catalog', None)
    key = args.get('key', [''])[0]
    if catalog is None or not key:
        return h.respond(400, {'error': 'Name the chat to search'})
    limit = min(1000, max(1, int(args.get('limit', ['200'])[0])))
    with catalog.lock:
        events = catalog.load(catalog.resolve(key)).events
        if args.get('thinking', [''])[0] != '1':   # the same filter /api/transcript applies, so an index means the same event
            events = [e for e in events if e['kind'] != 'thinking']
        return h.respond(200, prompts.find_prompts(events, args.get('q', [''])[0], limit))


def get_artifacts(h, ctx, parsed, args):
    return h.artifact_route(parsed)


# ---- POST handlers: (handler, ctx, body) ----

def post_conversation_state(h, ctx, body):
    return h.respond(*ctx.studio.conversation_action(body))


def post_settings(h, ctx, body):
    ctx.studio.settings.update(body)
    return h.respond(200, dict(ctx.studio.settings_view(), ok=True))


def post_project_prefs(h, ctx, body):
    ctx.studio.project_prefs.update(body)
    return h.respond(200, dict(ctx.studio.project_prefs.public(), ok=True))


def post_open(h, ctx, body):
    try:
        return h.respond(200, ctx.launcher.open(body))
    except editors.EditorError as error:
        return h.respond(error.status, {'error': str(error), 'code': error.code})


def post_folders_create(h, ctx, body):
    git_init = body.get('gitInit', False)
    if not isinstance(body.get('path'), str) or not isinstance(git_init, bool):
        raise ValueError('Invalid request')
    try:
        result = folders.create_folder(body['path'], git_init)
    except folders.FolderError as error:
        return h.respond(400, {'error': str(error), 'code': error.code})
    ctx.folder_memory.remember_project(result['path'])
    return h.respond(200, result)


def post_folders_remember(h, ctx, body):
    try:
        return h.respond(200, {'ok': True, 'parent': ctx.folder_memory.remember_project(body.get('path'))})
    except folders.FolderError as error:
        return h.respond(400, {'error': str(error), 'code': error.code})


def post_update_check(h, ctx, body):
    """Start a manual check in the background (a download can outlast a request); the page polls GET /api/live/update."""
    threading.Thread(target=ctx.updates.check, kwargs={'manual': True}, daemon=True, name='aib-update-check').start()
    status = ctx.updates.status()
    status['checking'] = True
    return h.respond(200, status)


def post_update_install(h, ctx, body):
    """Install now (the person clicked) or, with whenIdle, as soon as no chat is working. cancelWait drops the second. The server
    answers first, then quits so the helper can run the installer."""
    if body.get('cancelWait') is True:
        return h.respond(200, ctx.updates.cancel_wait())
    when_idle = body.get('whenIdle', False)
    if not isinstance(when_idle, bool):
        raise ValueError('whenIdle must be true or false')
    try:
        result = ctx.updates.install(when_idle)
    except updater.UpdateError as error:
        return h.respond({'chats_working': 409, 'not_ready': 409, 'manual': 400}.get(error.code, 500), dict({'error': str(error), 'code': error.code}, **error.extra))
    return h.respond(200, dict(result, ok=True))


def post_folders_pick(h, ctx, body):
    start = body.get('start', '')
    if not isinstance(start, str):
        raise ValueError('Invalid request')
    return h.respond(*folders.pick_folder(start))


def _install_agent(body):
    agent = body.get('agent')
    if not isinstance(agent, str):
        raise ValueError('agent must be text')
    return agent


def get_agent_install(h, ctx, parsed, args):
    """The agent install job's state: the page polls it while a row is installing (the job runs in the agent host)."""
    return h.respond(*ctx.studio.install_call('status', args.get('agent', [''])[0]))


def post_agent_install(h, ctx, body):
    """Start the install of Claude Code or Codex into Studio's own folder, or join the one already running. Page token and write scope; never the agent tool key."""
    return h.respond(*ctx.studio.install_call('start', _install_agent(body)))


def post_agent_install_cancel(h, ctx, body):
    """Cancel the install: its whole process tree is killed and the half-made folder is deleted."""
    return h.respond(*ctx.studio.install_call('cancel', _install_agent(body)))


def get_agent_signin(h, ctx, parsed, args):
    """The sign-in state of one agent and its Sign in job (waiting / failed / done / manual): the page polls it while a row waits for sign-in."""
    return h.respond(*ctx.studio.signin_call('status', args.get('agent', [''])[0]))


def post_agent_signin_check(h, ctx, body):
    """Refresh the cached "Ready / Needs sign-in / Not checked" state: Settings does this once when it opens, "Check again" with force. No agent = all built-ins."""
    agent = body.get('agent', '')
    if not isinstance(agent, str):
        raise ValueError('agent must be text')
    return h.respond(*ctx.studio.signin_call('check', agent, body.get('force') is True))


def post_agent_signin(h, ctx, body):
    """Run the agent's own login (a visible console window on Windows). Studio never reads or stores what the login produces. Page token and write scope; never the agent tool key."""
    return h.respond(*ctx.studio.signin_call('start', _install_agent(body)))


def post_agent_signin_cancel(h, ctx, body):
    """Cancel the sign-in: the login's whole process tree is killed."""
    return h.respond(*ctx.studio.signin_call('cancel', _install_agent(body)))


def post_live_op(h, ctx, body):
    """One of Studio.LIVE_POST_OPS: POST /api/live/<name> goes to the Studio (or the agent host) as a named call."""
    studio = ctx.studio
    name = h.path[len('/api/live/'):]
    status, payload = studio.live_call(name, body)
    if name == 'session-op' and isinstance(payload, dict):
        deleted = payload.pop('_deleted', None)
        if deleted:
            # The agent really deleted its copy: leave a Studio tombstone so the row cannot linger.
            title = body.get('title') if isinstance(body.get('title'), str) else ''
            try:
                studio.conversations.apply('delete', deleted[0], deleted[1], title=title, agent_deleted=True)
            except ValueError:
                pass
    h.respond(status, payload)


def post_shutdown(h, ctx):
    h.respond(200, {'ok': True})
    threading.Thread(target=h.server.shutdown, daemon=True, name='api-shutdown').start()   # serve() then runs the normal close path


def post_artifacts(h, ctx, path):
    """/api/live/artifacts/*: publish is for the agent tool (its key, bound to the body's conversation), the rest for the page."""
    tool_route = ctx.routes.security.scope_for('POST', path) == security.SCOPE_ARTIFACTS_TOOL
    allowed = None if tool_route else h.gate('POST', path)
    if not tool_route and not allowed:
        return h.refuse(path, allowed)
    try:
        length = int(h.headers.get('Content-Length', '0'))
        if not 0 < length <= artifacts.MAX_BODY_BYTES:
            raise ValueError('Invalid request size')
        body = json.loads(h.rfile.read(length))
    except (ValueError, TypeError) as error:
        return h.respond(400, {'error': str(error)})
    body = body if isinstance(body, dict) else {}
    if tool_route:   # an agent key is bound to the body's conversation
        allowed = h.gate('POST', path, body.get('conversationId'))
        if not allowed:
            return h.refuse(path, allowed)
    return h.artifact_route(urllib.parse.urlparse(h.path), body)


class Route:
    """One served route. kind: 'get' (handler gets the query), 'body' (a JSON object body is read first), 'bare' (no body is read),
    'own-gate' (the handler runs its own gate, because an agent key is checked after the body)."""

    def __init__(self, method, path, scope, handler, kind):
        self.method, self.path, self.scope, self.handler, self.kind = method, path, scope, handler, kind


ARTIFACTS_PREFIX = '/api/live/artifacts'
WORKTREE_TOOL_PATH = '/api/live/worktree/tool'


def route_specs(live_post_ops):
    """Every route Studio answers on top of the monitor's, in one list. live_post_ops: the names of the generic POST /api/live/<name> calls."""
    S = security
    specs = [('GET', '/api/live/bootstrap', S.SCOPE_BOOTSTRAP, get_bootstrap, 'get'),
             ('GET', '/api/live/ownership', S.SCOPE_READ, get_ownership, 'get'),
             ('GET', '/api/live/changes', S.SCOPE_READ, get_changes, 'get'),
             ('GET', '/api/live/changes/file', S.SCOPE_READ, get_changes, 'get'),
             ('GET', '/api/live/branch', S.SCOPE_READ, get_branch, 'get'),
             ('GET', '/api/live/worktree', S.SCOPE_READ, get_worktree, 'get'),
             ('GET', '/api/live/worktree/clash', S.SCOPE_READ, get_worktree_clash, 'get'),
             ('GET', '/api/live/list', S.SCOPE_READ, get_list, 'get'),
             ('GET', '/api/live/conversation-state', S.SCOPE_READ, get_conversation_state, 'get'),
             ('GET', '/api/live/project-prefs', S.SCOPE_READ, get_project_prefs, 'get'),
             ('GET', '/api/live/read-state', S.SCOPE_READ, get_read_state, 'get'),
             ('GET', '/api/live/editors', S.SCOPE_READ, get_editors, 'get'),
             ('GET', '/api/live/settings', S.SCOPE_READ, get_settings, 'get'),
             ('GET', '/api/live/update', S.SCOPE_READ, get_update, 'get'),
             ('GET', '/api/live/folders/check', S.SCOPE_READ, get_folders_check, 'get'),
             ('GET', '/api/live/folders/kinds', S.SCOPE_READ, get_folders_kinds, 'get'),
             ('GET', '/api/live/folders/start', S.SCOPE_READ, get_folders_start, 'get'),
             ('GET', '/api/live/state', S.SCOPE_READ, get_state, 'get'),
             ('GET', '/api/live/prompts', S.SCOPE_READ, get_prompts, 'get'),
             ('GET', '/api/live/agents/install', S.SCOPE_WRITE, get_agent_install, 'get'),   # install status: write scope like the two below
             ('GET', '/api/live/agents/signin', S.SCOPE_WRITE, get_agent_signin, 'get'),   # sign-in state: write scope like the install routes
             ('GET', '/api/live/artifacts', S.SCOPE_ARTIFACTS_TOOL, get_artifacts, 'get'),   # list: page token or the agent's key
             ('GET', '/api/live/artifacts/item', S.SCOPE_ARTIFACTS_READ, get_artifacts, 'get'),
             ('GET', '/api/live/artifacts/source', S.SCOPE_ARTIFACTS_READ, get_artifacts, 'get'),
             ('GET', '/api/live/artifacts/diff', S.SCOPE_ARTIFACTS_READ, get_artifacts, 'get'),
             ('POST', '/api/live/artifacts/publish', S.SCOPE_ARTIFACTS_TOOL, post_artifacts, 'own-gate'),
             ('POST', '/api/live/artifacts/preview', S.SCOPE_ARTIFACTS_WRITE, post_artifacts, 'own-gate'),
             ('POST', '/api/live/artifacts/pin', S.SCOPE_ARTIFACTS_WRITE, post_artifacts, 'own-gate'),
             ('POST', '/api/live/artifacts/restore', S.SCOPE_ARTIFACTS_WRITE, post_artifacts, 'own-gate'),
             ('POST', '/api/live/conversation-state', S.SCOPE_WRITE, post_conversation_state, 'body'),
             ('POST', '/api/live/settings', S.SCOPE_WRITE, post_settings, 'body'),
             ('POST', '/api/live/project-prefs', S.SCOPE_WRITE, post_project_prefs, 'body'),
             ('POST', '/api/live/read-state', S.SCOPE_WRITE, post_read_state, 'body'),
             ('POST', '/api/live/open', S.SCOPE_WRITE, post_open, 'body'),
             ('POST', '/api/live/agents/install', S.SCOPE_WRITE, post_agent_install, 'body'),
             ('POST', '/api/live/agents/install/cancel', S.SCOPE_WRITE, post_agent_install_cancel, 'body'),
             ('POST', '/api/live/agents/signin', S.SCOPE_WRITE, post_agent_signin, 'body'),
             ('POST', '/api/live/agents/signin/check', S.SCOPE_WRITE, post_agent_signin_check, 'body'),
             ('POST', '/api/live/agents/signin/cancel', S.SCOPE_WRITE, post_agent_signin_cancel, 'body'),
             ('POST', '/api/live/worktree/merge', S.SCOPE_WRITE, post_worktree_merge, 'body'),
             ('POST', '/api/live/worktree/clash', S.SCOPE_WRITE, post_worktree_clash, 'body'),
             ('POST', '/api/live/worktree/tool', S.SCOPE_WORKTREE_TOOL, post_worktree_tool, 'own-gate'),
             ('POST', '/api/live/folders/create', S.SCOPE_WRITE, post_folders_create, 'body'),
             ('POST', '/api/live/folders/remember', S.SCOPE_WRITE, post_folders_remember, 'body'),
             ('POST', '/api/live/folders/pick', S.SCOPE_WRITE, post_folders_pick, 'body'),
             ('POST', '/api/live/update/check', S.SCOPE_WRITE, post_update_check, 'body'),
             ('POST', '/api/live/update/install', S.SCOPE_WRITE, post_update_install, 'body')]
    specs += [('POST', '/api/live/' + name, S.SCOPE_WRITE, post_live_op, 'body') for name in live_post_ops]
    specs.append(('POST', '/api/live/shutdown', S.SCOPE_SHUTDOWN, post_shutdown, 'bare'))   # the desktop app calls this before it kills the process
    return specs


class Routes:
    """The one route table: dispatch lookup and the security.RouteTable are both read from the same Route entries."""

    def __init__(self, live_post_ops):
        self.entries = {}
        for method, path, scope, handler, kind in route_specs(live_post_ops):
            self.entries[(method, path)] = Route(method, path, scope, handler, kind)
        self.security = security.RouteTable().update(monitor.ROUTES)
        for route in self.entries.values():
            self.security.add(route.method, route.path, route.scope)

    def get(self, method, path):
        return self.entries.get((method, path))


def build_routes(live_post_ops):
    """The security.RouteTable for Studio's routes (the monitor's plus Studio's), as security.authorize reads it."""
    return Routes(live_post_ops).security


def make_handler(base, ctx):
    """The Studio request handler class, extending the monitor's (which keeps its own routes and checks)."""
    routes, artifact_store = ctx.routes, ctx.artifact_store

    class Handler(base):
        def send_header(self, keyword, value):
            if keyword == 'Content-Security-Policy':   # Studio pages may frame and show images from the artifact origin (and only that one)
                value = value.replace("frame-src 'self'", "frame-src 'self' " + artifact_store.origin).replace("img-src 'self'", "img-src 'self' " + artifact_store.origin)
            super().send_header(keyword, value)

        def artifact_route(self, parsed, body=None):
            """/api/live/artifacts*: the gate already ran (page token, or for publish and list the agent tool key)."""
            try:
                if body is None:
                    return self.respond(*ctx.artifact_service.handle_get(self, parsed.path, urllib.parse.parse_qs(parsed.query)))
                return self.respond(*ctx.artifact_service.handle_post(self, parsed.path, body))
            except HostUnavailable as error:
                self.unavailable(error)
            except (KeyError, ValueError, TypeError, OSError, RuntimeError) as error:
                self.respond(400, {'error': str(error)})

        def gate(self, method, path, conversation_id=None):
            """security.authorize for this route: a Principal, or a falsy Refusal. Unknown routes are refused."""
            return security.authorize(self, routes.security.scope_for(method, path), conversation_id)

        def refuse(self, path, refusal):
            self.respond(refusal.status, {'error': refusal.message(path)})

        def unavailable(self, error):
            self.respond(503, {'error': str(error), 'code': getattr(error, 'code', 'host_unavailable')})

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if not parsed.path.startswith('/api/live/') and studio_asset(parsed.path) is None:
                return super().do_GET()   # monitor routes: same checks and the same page token, enforced in monitor.py
            args = urllib.parse.parse_qs(parsed.query)
            allowed = self.gate('GET', parsed.path, args.get('conversationId', [''])[0])
            if not allowed:
                return self.refuse(parsed.path, allowed)
            try:
                route = routes.get('GET', parsed.path)
                if route is not None:
                    return route.handler(self, ctx, parsed, args)
                name = studio_asset(parsed.path)
                if name:
                    return self.respond(200, (HERE / name).read_bytes(), ('text/html' if name.endswith('.html') else 'text/javascript' if name.endswith('.js') else 'text/css') + '; charset=utf-8')
                self.respond(404, {'error': 'Not found'})
            except HostUnavailable as error:
                self.unavailable(error)
            except (KeyError, ValueError, OSError) as error:
                self.respond(400, {'error': str(error)})

        def do_POST(self):
            path = urllib.parse.urlparse(self.path).path
            if path == ARTIFACTS_PREFIX or path.startswith(ARTIFACTS_PREFIX + '/'):
                return post_artifacts(self, ctx, path)   # its own gate order: the agent key is checked after the body
            if path == WORKTREE_TOOL_PATH:
                return post_worktree_tool(self, ctx, path)   # its own gate order: the agent key is checked after the body
            allowed = self.gate('POST', path)
            if not allowed:
                return self.refuse(path, allowed)
            route = routes.get('POST', path)
            if route is not None and route.kind == 'bare':
                return route.handler(self, ctx)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                max_body = MAX_PROMPT_BODY_BYTES if self.path == '/api/live/prompt' else 1000000
                if not 0 < length <= max_body:
                    raise ValueError('Invalid request size')
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError('Invalid request')
                route = routes.get('POST', self.path)   # the raw path, as before: a query string is not a route
                if route is None or route.kind != 'body':
                    return self.respond(404, {'error': 'Not found'})
                route.handler(self, ctx, body)
            except HostUnavailable as error:
                self.unavailable(error)
            except (KeyError, ValueError, TypeError, OSError, RuntimeError, TimeoutError) as error:
                self.respond(400, {'error': str(error)})

    return Handler
