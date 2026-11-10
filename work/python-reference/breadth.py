"""ACP v1 breadth helpers for Agent Studio: slash commands, usage/session metadata,
notices/compaction, config validation, session operations and client MCP config.

Everything here treats agent-supplied values as untrusted data: strings are length
limited and never interpreted. Nothing is estimated; only reported values are kept."""
import json
import pathlib
import urllib.parse

MAX_COMMANDS = 500
MAX_NOTICES = 20
MAX_COMPACTIONS = 50
MAX_SUMMARY = 20000
MAX_MCP_SERVERS = 50
COMPACTION_STATUSES = ('in_progress', 'completed', 'failed', 'cancelled', 'other')
SESSION_OPS = ('list', 'close', 'delete')
DESTRUCTIVE_OPS = ('close', 'delete')

# What this client can display. Agents must not send these unless we advertise them.
CLIENT_SESSION_CAPABILITIES = {'configOptions': {'boolean': {}}, 'notices': {}, 'compaction': {}}


def augment_initialize(params):
    """Return initialize params that also advertise the session-level capabilities handled here."""
    caps = dict(params.get('clientCapabilities') or {})
    caps.setdefault('session', dict(CLIENT_SESSION_CAPABILITIES))
    return dict(params, clientCapabilities=caps)


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else None


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def new_state():
    return {'commands': [], 'usage': None, 'sessionInfo': {}, 'notices': [], 'compaction': {}, 'skippedMcp': [], 'notice_seq': 0, 'responseModel': None}


def clean_commands(raw):
    commands = []
    if not isinstance(raw, list):
        return commands
    for item in raw[:MAX_COMMANDS]:
        if not isinstance(item, dict):
            continue
        name = _text(item.get('name'), 100)
        if not name or not name.strip():
            continue
        name = name.strip().lstrip('/')
        if not name or any(ch.isspace() for ch in name):
            continue
        entry = {'name': name, 'description': _text(item.get('description'), 500) or ''}
        info = item.get('input')
        if isinstance(info, dict) and isinstance(info.get('hint'), str) and info['hint'].strip():
            entry['hint'] = info['hint'][:200]
        commands.append(entry)
    return commands


def _blocks_text(blocks):
    if isinstance(blocks, dict):
        blocks = [blocks]
    return ''.join(b['text'] for b in blocks if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str)) if isinstance(blocks, list) else ''


def apply_update(state, update, now=None):
    """Apply one session/update payload to the breadth state. Returns True when it was handled."""
    kind = update.get('sessionUpdate') if isinstance(update, dict) else None
    if kind == 'available_commands_update':
        state['commands'] = clean_commands(update.get('availableCommands'))
    elif kind == 'usage_update':
        size, used = _count(update.get('size')), _count(update.get('used'))
        usage = {'size': size, 'used': used, 'cost': None}
        cost = update.get('cost')
        if isinstance(cost, dict) and isinstance(cost.get('amount'), (int, float)) and not isinstance(cost.get('amount'), bool) \
                and isinstance(cost.get('currency'), str) and 0 < len(cost['currency']) <= 16:
            usage['cost'] = {'amount': cost['amount'], 'currency': cost['currency']}
        state['usage'] = usage if (size is not None or used is not None or usage['cost']) else None
        meta = update.get('_meta')  # Claude's adapter names the model behind the latest reply here
        model = _text(meta.get('_claude/model'), 200) if isinstance(meta, dict) else None
        if model and model.strip() and not model.startswith('<') and model.isprintable():
            state['responseModel'] = model.strip()
    elif kind == 'session_info_update':
        info = state['sessionInfo']
        for key, limit in (('title', 300), ('updatedAt', 64)):
            if key in update:
                value = _text(update[key], limit)
                if value is None:
                    info.pop(key, None)
                else:
                    info[key] = value
    elif kind == 'notice':
        title = _text(update.get('title'), 200)
        if title and title.strip():
            state['notice_seq'] += 1
            severity = _text(update.get('severity'), 40) or 'info'
            state['notices'].append({'id': state['notice_seq'], 'title': title, 'description': _text(update.get('description'), 1000) or '', 'severity': severity, 'time': now})
            del state['notices'][:-MAX_NOTICES]
    elif kind in ('compaction_update', 'compaction_summary_chunk'):
        cid = _text(update.get('compactionId'), 200)
        if not cid:
            return True
        table = state['compaction']
        item = table.setdefault(cid, {'id': cid, 'status': 'in_progress', 'error': '', 'summary': ''})
        while len(table) > MAX_COMPACTIONS:
            table.pop(next(iter(table)))
        if kind == 'compaction_summary_chunk':
            item['summary'] = (item['summary'] + _blocks_text(update.get('content')))[:MAX_SUMMARY]
        else:
            if 'status' in update:
                item['status'] = update['status'] if update['status'] in COMPACTION_STATUSES else 'other'
            if 'error' in update:
                item['error'] = _text(update['error'], 1000) or ''
            if 'summary' in update:
                item['summary'] = _blocks_text(update['summary'])[:MAX_SUMMARY]
    else:
        return False
    return True


def session_capabilities(initial):
    """Which advertised session operations exist. Only spec-defined capabilities; no fork in ACP v1."""
    agent = initial.get('agentCapabilities') if isinstance(initial, dict) else None
    agent = agent if isinstance(agent, dict) else {}
    caps = agent.get('sessionCapabilities')
    caps = caps if isinstance(caps, dict) else {}
    mcp = agent.get('mcpCapabilities') if isinstance(agent.get('mcpCapabilities'), dict) else {}
    ops = [op for op in SESSION_OPS if isinstance(caps.get(op), dict)]
    return {'ops': ops, 'resume': isinstance(caps.get('resume'), dict), 'loadSession': agent.get('loadSession') is True,
        'mcp': {'http': mcp.get('http') is True, 'sse': mcp.get('sse') is True}}


def public_state(connection):
    state = connection.breadth
    caps = session_capabilities(connection.initial)
    return {'commands': list(state['commands']), 'usage': state['usage'], 'sessionInfo': dict(state['sessionInfo']),
        'notices': list(state['notices']), 'compaction': list(state['compaction'].values()),
        'responseModel': state.get('responseModel'), 'ops': caps['ops'], 'resume': caps['resume'], 'mcp': dict(caps['mcp'], configured=len(getattr(connection, 'mcp_servers', [])), skipped=list(state['skippedMcp']))}


# ---- configuration options ---------------------------------------------------------------

def _option_values(option):
    values = []
    for item in option.get('options') or []:
        if isinstance(item, dict) and isinstance(item.get('options'), list):
            values.extend(o.get('value') for o in item['options'] if isinstance(o, dict))
        elif isinstance(item, dict):
            values.append(item.get('value'))
    return values


def build_config_request(settings, config_id, value):
    """Validate a UI request against the agent's reported options and return session/set_config_option params."""
    options = settings.get('configOptions') if isinstance(settings, dict) else None
    option = next((o for o in options or [] if isinstance(o, dict) and o.get('id') == config_id), None)
    if option is None:
        raise ValueError('Unknown setting')
    kind = option.get('type')
    if kind == 'boolean':
        if not isinstance(value, bool):
            raise ValueError('This setting needs true or false')
        return {'configId': config_id, 'type': 'boolean', 'value': value}
    if kind == 'select':
        if not isinstance(value, str) or value not in _option_values(option):
            raise ValueError('That is not one of this setting\'s listed values')
        # ACP v2 adapters require the `type` discriminator: "boolean" for switches, "id" for a choice from a list.
        return {'configId': config_id, 'type': 'id', 'value': value}
    raise ValueError('This setting type is not supported by Studio; it is shown read-only')


def check_mode(settings, mode_id):
    """Validate a UI mode request against the advertised modes (when the agent advertised any)."""
    if not isinstance(mode_id, str) or not mode_id or len(mode_id) > 200:
        raise ValueError('Unknown mode')
    modes = settings.get('modes') if isinstance(settings, dict) else None
    available = modes.get('availableModes') if isinstance(modes, dict) else None
    if isinstance(available, list) and available and not any(isinstance(m, dict) and m.get('id') == mode_id for m in available):
        raise ValueError('That is not one of the listed modes')
    return mode_id


def current_value(settings, kind, config_id=None):
    """The agent's current value of a mode ('mode') or config option ('config', id); None when unknown."""
    if not isinstance(settings, dict):
        return None
    if kind == 'mode':
        modes = settings.get('modes')
        return modes.get('currentModeId') if isinstance(modes, dict) else None
    option = next((o for o in settings.get('configOptions') or [] if isinstance(o, dict) and o.get('id') == config_id), None)
    return option.get('currentValue') if option else None


# ---- session operations ------------------------------------------------------------------

def session_op(connection, body):
    """Run an advertised session operation. Close/delete need an explicit server-checked confirmation."""
    op = body.get('op')
    caps = session_capabilities(connection.initial)
    if op not in SESSION_OPS or op not in caps['ops']:
        raise ValueError('This agent does not advertise that session operation')
    if connection.closed or not connection.ready or not connection.session_id:
        raise ValueError('This connection is not ready')
    if op == 'list':
        params = {}
        cursor, cwd = body.get('cursor'), body.get('cwd')
        if cursor is not None:
            if not isinstance(cursor, str) or len(cursor) > 2000:
                raise ValueError('Invalid cursor')
            params['cursor'] = cursor
        if cwd is not None:
            if not isinstance(cwd, str) or len(cwd) > 1000:
                raise ValueError('Invalid folder filter')
            params['cwd'] = cwd
        result = connection.request('session/list', params, 30)
        sessions = []
        for item in (result.get('sessions') if isinstance(result, dict) else None) or []:
            if isinstance(item, dict) and isinstance(item.get('sessionId'), str):
                sessions.append({'sessionId': item['sessionId'][:512], 'cwd': _text(item.get('cwd'), 1000) or '', 'title': _text(item.get('title'), 300) or '', 'updatedAt': _text(item.get('updatedAt'), 64) or ''})
        nxt = result.get('nextCursor') if isinstance(result, dict) else None
        return {'sessions': sessions[:200], 'nextCursor': nxt if isinstance(nxt, str) else None}
    if connection.busy:
        raise ValueError('Wait for the current turn, or interrupt it, before changing the session')
    if body.get('confirm') != f'{op}:{connection.session_id}':
        raise ValueError('Confirm this action for the current session first')
    connection.request(f'session/{op}', {'sessionId': connection.session_id}, 30)
    connection.event('session_op', {'op': op, 'sessionId': connection.session_id})
    connection.close()
    return {'done': op}


# ---- client-supplied MCP configuration ---------------------------------------------------

def _pairs(value, label):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f'{label} must be a list of {{"name", "value"}} objects')
    out = []
    for item in value:
        if not isinstance(item, dict) or set(item) - {'name', 'value'} or not isinstance(item.get('name'), str) or not item['name'] or not isinstance(item.get('value'), str):
            raise ValueError(f'Each entry in {label} needs string "name" and "value" only')
        out.append({'name': item['name'], 'value': item['value']})
    return out


def validate_mcp_servers(data):
    if isinstance(data, dict):
        extra = set(data) - {'mcpServers'}
        if extra or 'mcpServers' not in data:
            raise ValueError('MCP config must be a list of servers or {"mcpServers": [...]}')
        data = data['mcpServers']
    if not isinstance(data, list) or len(data) > MAX_MCP_SERVERS:
        raise ValueError(f'MCP config needs a list of at most {MAX_MCP_SERVERS} servers')
    servers, names = [], set()
    for index, item in enumerate(data):
        where = f'MCP server #{index + 1}'
        if not isinstance(item, dict):
            raise ValueError(f'{where} must be an object')
        name, kind = item.get('name'), item.get('type', 'stdio')
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError(f'{where} needs a non-empty "name"')
        if name in names:
            raise ValueError(f'Duplicate MCP server name: {name}')
        names.add(name)
        if kind == 'stdio':
            if set(item) - {'name', 'type', 'command', 'args', 'env'}:
                raise ValueError(f'{where} has fields stdio servers do not support')
            command, args = item.get('command'), item.get('args', [])
            if not isinstance(command, str) or not command.strip():
                raise ValueError(f'{where} needs a "command"')
            if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
                raise ValueError(f'{where} "args" must be a list of strings')
            servers.append({'name': name, 'command': command, 'args': args, 'env': _pairs(item.get('env'), f'{where} "env"')})
        elif kind in ('http', 'sse'):
            if set(item) - {'name', 'type', 'url', 'headers'}:
                raise ValueError(f'{where} has fields {kind} servers do not support')
            url = item.get('url')
            parsed = urllib.parse.urlparse(url) if isinstance(url, str) else None
            if not parsed or parsed.scheme not in ('http', 'https') or not parsed.netloc:
                raise ValueError(f'{where} needs an http(s) "url"')
            servers.append({'type': kind, 'name': name, 'url': url, 'headers': _pairs(item.get('headers'), f'{where} "headers"')})
        else:
            raise ValueError(f'{where} has unsupported type "{kind}" (use stdio, http, or sse)')
    return servers


def load_mcp_config(path):
    path = pathlib.Path(path)
    try:
        if path.stat().st_size > 1_000_000:
            raise ValueError('MCP config file is larger than 1 MB')
        data = json.loads(path.read_text(encoding='utf-8'))
    except OSError as error:
        raise ValueError(f'Cannot read MCP config: {error}')
    except json.JSONDecodeError as error:
        raise ValueError(f'MCP config is not valid JSON: {error}')
    return validate_mcp_servers(data)


def select_mcp_servers(servers, initial):
    """stdio always; http/sse only when the agent advertises them. Returns (usable, skipped names)."""
    mcp = session_capabilities(initial)['mcp']
    usable, skipped = [], []
    for server in servers:
        if server.get('type', 'stdio') == 'stdio' or mcp.get(server['type']):
            usable.append(server)
        else:
            skipped.append(server['name'])
    return usable, skipped
