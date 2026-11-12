#!/usr/bin/env python3
"""Studio's artifact tool: a stdio MCP server (`studio_artifact`) that lets an agent show the user a page.

Studio adds it to every session. Environment:
  STUDIO_ARTIFACT_URL        Studio base URL, e.g. http://127.0.0.1:8767 (may be empty; see STUDIO_ARTIFACT_URL_FILE)
  STUDIO_ARTIFACT_URL_FILE   optional JSON file {"url": ...} that Studio rewrites when it restarts on another port
  STUDIO_ARTIFACT_KEY        per-conversation key sent as X-Studio-Artifact-Key
  STUDIO_CONVERSATION_ID     the Studio conversation this agent belongs to
JSON-RPC 2.0 over stdin/stdout, one JSON message per line. Standard library only.
"""
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import logging

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

from version import __version__

SERVER_NAME = 'studio_artifact'
SERVER_VERSION = __version__
SUPPORTED_VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
KINDS = ['html', 'svg', 'md', 'image', 'pdf', 'csv', 'json', 'text']
HTTP_TIMEOUT = 60

INSTRUCTIONS = ('Use these tools to show the user an HTML page, diagram, report or document in AIB\'s Artifacts panel. '
                'Do not use them for source code. When you mention an artifact in a reply, write it as a Markdown link '
                '[Title](studio-artifact://<id>).')

TOOLS = [
    {
        'name': 'publish',
        'title': 'Publish an artifact',
        'description': ('Show the user an HTML page, diagram (SVG), image, PDF, CSV, JSON, or a one-off Markdown report in the Artifacts panel next to the chat: '
                        'something to look at or click through. Do NOT use it for a plan, spec, notes, checklist or anything the user will want to edit or keep in '
                        'the project: make a doc with doc_create. If the page shows content from a doc (a timeline of its Rollout page, a chart of its table), pass '
                        '"fromDoc": {"doc": "<name>", "page": "<page>"} so the user can rebuild it when the doc changes. Do NOT use it for source code or files the user '
                        'only needs on disk. Give either `path` (an existing file; relative paths are resolved against the session folder) or `content` (the text itself, with '
                        '`filename` such as "report.html" so AIB knows the kind). HTML pages are shown sandboxed: scripts from cdnjs.cloudflare.com, cdn.jsdelivr.net and '
                        'unpkg.com are allowed, but the page cannot make network requests, so embed its data inline. To change a page you already published, call `update` with its id '
                        'instead of publishing a new one. After publishing, mention it in your reply as a Markdown link: [Title](studio-artifact://<id>).'),
        'inputSchema': {
            'type': 'object',
            'properties': {
                'title': {'type': 'string', 'description': 'Short human title shown in the Artifacts picker, e.g. "Drop rates by tier".'},
                'path': {'type': 'string', 'description': 'Path of an existing file to publish (absolute, or relative to the session folder). Give this or `content`, not both.'},
                'content': {'type': 'string', 'description': 'The file text to publish (HTML, SVG, Markdown, CSV, JSON, ...). Give this or `path`, not both.'},
                'filename': {'type': 'string', 'description': 'With `content`: the file name including extension, e.g. "chart.html". Decides the kind when `kind` is omitted.'},
                'kind': {'type': 'string', 'enum': KINDS, 'description': 'Optional. Derived from the file extension when omitted.'},
                'fromDoc': {
                    'type': 'object',
                    'description': ('Optional. The doc page this artifact shows, e.g. {"doc": "release-plan", "page": "Rollout"}: the user sees '
                                    '"Built from" with a link to it, and "Rebuild from the doc" once the page changes.'),
                    'properties': {
                        'doc': {'type': 'string', 'description': "The doc's name, as doc_list gives it."},
                        'page': {'type': 'string', 'description': "The page's title or id. Default: the doc's first page."},
                    },
                    'required': ['doc'],
                    'additionalProperties': False,
                },
            },
            'required': ['title'],
            'additionalProperties': False,
        },
    },
    {
        'name': 'update',
        'title': 'Update an artifact',
        'description': ('Publish a new version of an artifact you already published in this conversation (the user can compare and restore versions). Pass its `id` and the '
                        'new `path` or `content`. Use this instead of `publish` when revising a page. Identical content creates no new version. Keep referring to it as '
                        '[Title](studio-artifact://<id>). When the user asks to rebuild an artifact from its doc, read that page with doc_read first, then update.'),
        'inputSchema': {
            'type': 'object',
            'properties': {
                'id': {'type': 'string', 'description': 'The artifact id returned by `publish` or `list`.'},
                'path': {'type': 'string', 'description': 'Path of the file with the new version (absolute, or relative to the session folder). Give this or `content`, not both.'},
                'content': {'type': 'string', 'description': 'The new file text. Give this or `path`, not both.'},
                'note': {'type': 'string', 'description': 'Optional one-line description of what changed, shown in the version list.'},
                'fromDoc': {
                    'type': 'object',
                    'description': ('Optional. The doc page this artifact shows, e.g. {"doc": "release-plan", "page": "Rollout"}: the user sees '
                                    '"Built from" with a link to it, and "Rebuild from the doc" once the page changes.'),
                    'properties': {
                        'doc': {'type': 'string', 'description': "The doc's name, as doc_list gives it."},
                        'page': {'type': 'string', 'description': "The page's title or id. Default: the doc's first page."},
                    },
                    'required': ['doc'],
                    'additionalProperties': False,
                },
            },
            'required': ['id'],
            'additionalProperties': False,
        },
    },
    {
        'name': 'list',
        'title': 'List artifacts',
        'description': 'List the artifacts published in this conversation (id, title, kind, version, link). Use it to find an id to `update`, or to check what the user already has.',
        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
    },
]


WORKTREE_TOOLS = [
    {
        'name': 'merge_into_project',
        'title': 'Merge this chat\'s work into the project',
        'description': ('Merge the work of this chat (done in its own copy of the project, on its own branch) into the project. It works only after the user pressed '
                        'Merge into main (or their base branch) in the Changes tab; AIB then sends you a message asking you to merge. A "yes" typed in the chat is not '
                        'enough, and the permission ends when your work changes after the click or the user sends a new message. Without it nothing is merged and the '
                        "reply tells you to point the user to that button. It merges this chat's own work and nothing else. The reply says how many commits were "
                        'merged, or exactly why nothing was merged (for example: conflicts to resolve, or a terminal you started is still running) and what to do.'),
        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
    },
    {
        'name': 'resolve_edit_clash',
        'title': 'Resolve a clash with the user\'s own edits',
        'description': ('After a merge, the user\'s own unsaved edits in the project folder can clash with it; AIB then tells you which files and the name of the stash '
                        'that keeps their edits. Use `check` after you combined those files yourself in the project folder (AIB looks for leftover conflict markers), '
                        '`keep_mine` only when the user says to keep their version (their edits win in those files), `leave` when the user says they will sort it out themselves.'),
        'inputSchema': {
            'type': 'object',
            'properties': {'action': {'type': 'string', 'enum': ['check', 'keep_mine', 'leave'], 'description': 'What the user decided.'}},
            'required': ['action'],
            'additionalProperties': False,
        },
    },
]


def worktree_enabled():
    return os.environ.get('STUDIO_WORKTREE') == '1'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None   # a redirect would carry the key header to wherever it points


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)   # never through HTTP_PROXY: the key is for this machine only


class ToolError(Exception):
    """A failure to report to the agent as an MCP tool error (isError), not a protocol error."""


_LOOPBACK_URL = re.compile(r'^http://(?:127\.0\.0\.1|localhost):([0-9]{1,5})$')


def loopback_url(value):
    """The URL when it is exactly http://127.0.0.1:<port> or http://localhost:<port> (no path, userinfo or other host); else ''.
    The artifact key travels in a header, so it must never be sent anywhere but this machine's Studio."""
    text = str(value or '').strip().rstrip('/')
    match = _LOOPBACK_URL.match(text)
    return text if match and 0 < int(match.group(1)) < 65536 else ''


def base_url():
    return loopback_url(os.environ.get('STUDIO_ARTIFACT_URL', ''))


def url_from_file():
    path = os.environ.get('STUDIO_ARTIFACT_URL_FILE', '').strip()
    if not path:
        return ''
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
        return loopback_url(data.get('url'))
    except (OSError, ValueError, AttributeError):
        return ''


def resolve_path(value):
    """Absolute path for a path argument; relative paths are relative to the session folder (this process's cwd)."""
    if not isinstance(value, str) or not value.strip():
        raise ToolError('`path` must be a non-empty string')
    path = pathlib.Path(os.path.expanduser(value.strip()))
    if not path.is_absolute():
        path = pathlib.Path(os.getcwd()) / path
    path = pathlib.Path(os.path.normpath(str(path)))
    if not path.is_file():
        raise ToolError(f'File not found: {path}')
    return str(path)


def http(method, route, query=None, body=None, soft=False):
    """soft: an HTTP error that carries Studio's own reason (not a refused key) comes back as {'error': reason, 'status': code}, not as a ToolError."""
    key = os.environ.get('STUDIO_ARTIFACT_KEY', '')
    conversation = os.environ.get('STUDIO_CONVERSATION_ID', '')
    if not key or not conversation:
        raise ToolError('The artifact tool is not configured for this conversation (missing key or conversation id).')
    last = None
    roots = []
    for root in (base_url(), url_from_file()):  # the file wins on retry: Studio may have restarted on another port
        if root and root not in roots:
            roots.append(root)
    if not roots:
        raise ToolError('AIB did not tell the artifact tool where it is running.')
    for root in roots[:2]:
        url = root + route + ('?' + urllib.parse.urlencode(query) if query else '')
        data = json.dumps(body).encode('utf-8') if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            'X-Studio-Artifact-Key': key, 'Accept': 'application/json',
            **({'Content-Type': 'application/json'} if data is not None else {})})
        try:
            with OPENER.open(request, timeout=HTTP_TIMEOUT) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                message = json.loads(raw.decode('utf-8', 'replace')).get('error')
            except (ValueError, AttributeError):
                message = None
            if error.code in (401, 403):
                message = message or 'AIB refused the artifact key for this conversation'
            elif soft and message:
                return {'error': message, 'status': error.code}
            raise ToolError(f'AIB returned {error.code}: {message or error.reason}')
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            last = error
            continue
        try:
            return json.loads(raw.decode('utf-8'))
        except ValueError:
            raise ToolError('AIB returned a reply that is not JSON')
    reason = getattr(last, 'reason', last)
    raise ToolError(f'Could not reach AIB ({reason}). It may be restarting; try again in a moment.')


def text_result(sentence, data):
    return {'content': [{'type': 'text', 'text': sentence + '\n' + json.dumps(data, ensure_ascii=False)}]}


def source_args(args):
    path, content = args.get('path'), args.get('content')
    has_path, has_content = path not in (None, ''), content is not None
    if has_path and has_content:
        raise ToolError('Give either `path` or `content`, not both')
    if not (has_path or has_content):
        raise ToolError('Give either `path` (a file) or `content` (the text to publish)')
    if has_path:
        return {'path': resolve_path(path)}
    if not isinstance(content, str):
        raise ToolError('`content` must be a string')
    return {'content': content}


def optional_string(args, name):
    value = args.get(name)
    if value is None or value == '':
        return None
    if not isinstance(value, str):
        raise ToolError(f'`{name}` must be a string')
    return value


def tool_publish(args):
    title = optional_string(args, 'title')
    if not title or not title.strip():
        raise ToolError('`title` is required')
    body = {'conversationId': os.environ.get('STUDIO_CONVERSATION_ID', ''), 'title': title.strip(), **source_args(args)}
    filename = optional_string(args, 'filename')
    if filename:
        body['filename'] = filename
    kind = optional_string(args, 'kind')
    if kind:
        if kind not in KINDS:
            raise ToolError('`kind` must be one of: ' + ', '.join(KINDS))
        body['kind'] = kind
    if isinstance(args.get('fromDoc'), dict):
        body['fromDoc'] = args['fromDoc']
    item = http('POST', '/api/live/artifacts/publish', body=body)
    out = {k: item.get(k) for k in ('id', 'version', 'link', 'url')}
    name = item.get('title') or title
    return text_result(f'Published "{name}" as artifact {out["id"]} (v{out["version"]}). Mention it in your reply as [{name}]({out["link"]}).', out)


def tool_update(args):
    identifier = optional_string(args, 'id')
    if not identifier:
        raise ToolError('`id` is required (from `publish` or `list`)')
    body = {'conversationId': os.environ.get('STUDIO_CONVERSATION_ID', ''), 'id': identifier, **source_args(args)}
    note = optional_string(args, 'note')
    if note:
        body['note'] = note
    if isinstance(args.get('fromDoc'), dict):
        body['fromDoc'] = args['fromDoc']
    item = http('POST', '/api/live/artifacts/publish', body=body)
    out = {k: item.get(k) for k in ('id', 'version', 'link')}
    return text_result(f'Updated "{item.get("title") or identifier}" (artifact {out["id"]}), now v{out["version"]}.', out)


def tool_list(args):
    reply = http('GET', '/api/live/artifacts', query={'conversationId': os.environ.get('STUDIO_CONVERSATION_ID', '')})
    items = [{k: a.get(k) for k in ('id', 'title', 'kind', 'version', 'link')} for a in (reply.get('artifacts') or []) if isinstance(a, dict)]
    return text_result(f'{len(items)} artifact(s) in this conversation.' if items else 'No artifacts in this conversation yet.', items)


def worktree_call(action):
    """Plain text for the agent: what happened, or the exact reason nothing did."""
    reply = http('POST', '/api/live/worktree/tool', body={'conversationId': os.environ.get('STUDIO_CONVERSATION_ID', ''), 'action': action}, soft=True)
    if reply.get('error'):
        what = 'Not merged' if action == 'merge' else 'Not done'
        return {'content': [{'type': 'text', 'text': f'{what}: {reply["error"]}'}], 'isError': True}
    if action == 'merge':
        if reply.get('state') == 'conflicts':
            return {'content': [{'type': 'text', 'text': 'Not merged yet. ' + str(reply.get('message') or '') + ' Then call merge_into_project again.'}]}
        text = f'{reply.get("message")}. Your copy now continues from the new {reply.get("base")}.'
        if reply.get('guidance'):
            text += '\n' + str(reply['guidance'])
        return {'content': [{'type': 'text', 'text': text}]}
    return {'content': [{'type': 'text', 'text': str(reply.get('message') or 'Done.')}]}


def tool_merge(args):
    return worktree_call('merge')


def tool_resolve_clash(args):
    action = args.get('action')
    if action not in ('check', 'keep_mine', 'leave'):
        raise ToolError('`action` must be one of: check, keep_mine, leave')
    return worktree_call(action)


HANDLERS = {'publish': tool_publish, 'update': tool_update, 'list': tool_list}
WORKTREE_HANDLERS = {'merge_into_project': tool_merge, 'resolve_edit_clash': tool_resolve_clash}


def handlers():
    return dict(HANDLERS, **WORKTREE_HANDLERS) if worktree_enabled() else HANDLERS


def call_tool(name, args):
    if not isinstance(args, dict):
        args = {}
    try:
        return handlers()[name](args)
    except ToolError as error:
        return {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}
    except Exception as error:  # never crash the server on a tool
        log.exception('Artifact tool failed')
        return {'content': [{'type': 'text', 'text': f'Artifact tool failed: {type(error).__name__}: {error}'}], 'isError': True}


def handle(message):
    """Returns the response object for a request, or None for notifications and responses."""
    if not isinstance(message, dict):
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}
    method, ident = message.get('method'), message.get('id')
    if method is None or 'id' not in message:
        return None  # notification (notifications/initialized, cancelled, ...) or a response we never asked for
    params = message.get('params') if isinstance(message.get('params'), dict) else {}

    def ok(result):
        return {'jsonrpc': '2.0', 'id': ident, 'result': result}

    def fail(code, text):
        return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': code, 'message': text}}

    if method == 'initialize':
        asked = params.get('protocolVersion')
        version = asked if asked in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0]
        return ok({'protocolVersion': version, 'capabilities': {'tools': {'listChanged': False}},
                   'serverInfo': {'name': SERVER_NAME, 'title': 'AIB artifacts', 'version': SERVER_VERSION}, 'instructions': INSTRUCTIONS})
    if method == 'ping':
        return ok({})
    if method == 'tools/list':
        return ok({'tools': TOOLS + (WORKTREE_TOOLS if worktree_enabled() else [])})
    if method == 'tools/call':
        name = params.get('name')
        if name not in handlers():
            return fail(-32602, f'Unknown tool: {name}')
        return ok(call_tool(name, params.get('arguments')))
    return fail(-32601, f'Method not found: {method}')


def main():
    out = sys.stdout
    for raw in sys.stdin.buffer:
        line = raw.decode('utf-8', 'replace').strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            reply = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}}
        else:
            try:
                reply = handle(message)
            except Exception as error:
                log.exception('MCP message handling failed')
                ident = message.get('id') if isinstance(message, dict) else None
                reply = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32603, 'message': f'Internal error: {error}'}}
        if reply is not None:
            out.write(json.dumps(reply, ensure_ascii=False) + '\n')
            out.flush()


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    main()
