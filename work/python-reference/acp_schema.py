"""Stdlib validators for the ACP v1 messages Agent Studio receives from an agent.

Reference: https://agentclientprotocol.com and the published schema.json
(github.com/agentclientprotocol/agent-client-protocol, schema-v1.x). Only the
shapes Studio relies on are checked; unknown *future* extensions are tolerated:
  - unknown session/update kinds are passed through and logged once,
  - unknown ContentBlock types, extra fields and `_meta` are ignored,
  - optional fields with the wrong type are ignored (the spec marks them
    default-on-error), only REQUIRED fields are enforced.

Entry point: ``screen(connection, line)``. It parses one stdout line from the
agent, validates it, records a ``protocol`` problem as an ``error`` event
(``data.protocol == True``), answers malformed *requests* with a JSON-RPC error,
fails the waiting RPC for malformed *responses* (so callers never hang), and
returns the parsed message to dispatch, or None to drop it. It never raises.
"""
import json
import logging

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

STOP_REASONS = ('end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled')
TOOL_STATUSES = ('pending', 'in_progress', 'completed', 'failed')
PERMISSION_KINDS = ('allow_once', 'allow_always', 'reject_once', 'reject_always')
MAX_PROTOCOL_EVENTS = 25  # per connection, so a hostile agent cannot flood history
# Adapter extensions Studio already understands (the Claude ACP adapter's subagent announcements and
# delegation messages). They are not in the v1 schema but are expected traffic, so no warning is shown.
KNOWN_EXTENSION_UPDATES = ('subagent_update', 'session_message')

INVALID_REQUEST, INVALID_PARAMS = -32600, -32602


class ProtocolError(ValueError):
    """A message violates the ACP v1 schema. ``code`` is the JSON-RPC error code to reply with."""

    def __init__(self, message, code=INVALID_PARAMS):
        super().__init__(message)
        self.code = code


def _is_id(value):
    return isinstance(value, (str, int)) and not isinstance(value, bool)


def _str(obj, key, where, nonempty=False):
    value = obj.get(key)
    if not isinstance(value, str) or (nonempty and not value):
        raise ProtocolError(f'{where}.{key} must be a {"non-empty " if nonempty else ""}string')
    return value


def _obj(value, where):
    if not isinstance(value, dict):
        raise ProtocolError(f'{where} must be an object')
    return value


def _list(value, where):
    if not isinstance(value, list):
        raise ProtocolError(f'{where} must be an array')
    return value


# ---- envelope --------------------------------------------------------------

def message_kind(message):
    """Classify a decoded JSON-RPC message: request, notification, or response. Raises ProtocolError."""
    if not isinstance(message, dict):
        raise ProtocolError('JSON-RPC message must be an object', INVALID_REQUEST)
    if message.get('jsonrpc') != '2.0':
        raise ProtocolError('JSON-RPC message must declare "jsonrpc": "2.0"', INVALID_REQUEST)
    if 'id' in message and message['id'] is not None and not _is_id(message['id']):
        raise ProtocolError('JSON-RPC id must be a string or integer', INVALID_REQUEST)
    if 'method' in message:
        if not isinstance(message['method'], str) or not message['method']:
            raise ProtocolError('JSON-RPC method must be a non-empty string', INVALID_REQUEST)
        if 'params' in message and not isinstance(message['params'], dict):
            raise ProtocolError('JSON-RPC params must be an object', INVALID_PARAMS)
        if 'id' in message:
            if message['id'] is None:
                raise ProtocolError('JSON-RPC request id must not be null', INVALID_REQUEST)
            return 'request'
        return 'notification'
    if 'id' not in message:
        raise ProtocolError('JSON-RPC message has neither method nor id', INVALID_REQUEST)
    has_result, has_error = 'result' in message, 'error' in message
    if has_result == has_error:
        raise ProtocolError('JSON-RPC response must contain exactly one of result or error', INVALID_REQUEST)
    if has_error:
        error = message['error']
        if not isinstance(error, dict) or isinstance(error.get('code'), bool) or not isinstance(error.get('code'), int) or not isinstance(error.get('message'), str):
            raise ProtocolError('JSON-RPC error must be an object with integer code and string message', INVALID_REQUEST)
    return 'response'


# ---- content / shared shapes ----------------------------------------------

def validate_content_block(block, where='content'):
    _obj(block, where)
    kind = _str(block, 'type', where)
    if kind == 'text':
        _str(block, 'text', where)
    elif kind in ('image', 'audio'):
        _str(block, 'data', where)
        _str(block, 'mimeType', where)
    elif kind == 'resource_link':
        _str(block, 'name', where)
        _str(block, 'uri', where)
    elif kind == 'resource':
        _obj(block.get('resource'), where + '.resource')
    # unknown block types are tolerated


def _validate_tool_content(items, where):
    # Spec: invalid items are skipped by the receiver, so only the container type matters.
    if items is not None:
        _list(items, where)


def _validate_modes(modes, where):
    if modes is None:
        return
    _obj(modes, where)
    _str(modes, 'currentModeId', where)
    for index, mode in enumerate(_list(modes.get('availableModes'), where + '.availableModes')):
        _str(_obj(mode, f'{where}.availableModes[{index}]'), 'id', f'{where}.availableModes[{index}]')


def _validate_config_options(options, where, required=False):
    if options is None and not required:
        return
    for index, option in enumerate(_list(options, where)):
        _obj(option, f'{where}[{index}]')


# ---- session/update --------------------------------------------------------

def _chunk(update):
    validate_content_block(update.get('content'), 'update.content')


def _tool_call(update):
    _str(update, 'toolCallId', 'update', nonempty=True)
    if update.get('sessionUpdate') == 'tool_call':
        _str(update, 'title', 'update')
    _validate_tool_content(update.get('content'), 'update.content')
    if update.get('locations') is not None:
        _list(update['locations'], 'update.locations')


def _plan(update):
    for index, entry in enumerate(_list(update.get('entries'), 'update.entries')):
        entry = _obj(entry, f'update.entries[{index}]')
        _str(entry, 'content', f'update.entries[{index}]')


def _commands(update):
    for index, command in enumerate(_list(update.get('availableCommands'), 'update.availableCommands')):
        command = _obj(command, f'update.availableCommands[{index}]')
        _str(command, 'name', f'update.availableCommands[{index}]')


def _number(update, key):
    if isinstance(update.get(key), bool) or not isinstance(update.get(key), (int, float)):
        raise ProtocolError(f'update.{key} must be a number')


def _usage(update):
    _number(update, 'used')
    _number(update, 'size')


def _compaction(update):
    _str(update, 'compactionId', 'update')


def _compaction_chunk(update):
    _str(update, 'compactionId', 'update')
    validate_content_block(update.get('content'), 'update.content')


UPDATE_VALIDATORS = {
    'user_message_chunk': _chunk,
    'agent_message_chunk': _chunk,
    'agent_thought_chunk': _chunk,
    'tool_call': _tool_call,
    'tool_call_update': _tool_call,
    'plan': _plan,
    'available_commands_update': _commands,
    'current_mode_update': lambda u: _str(u, 'currentModeId', 'update'),
    'config_option_update': lambda u: _validate_config_options(u.get('configOptions'), 'update.configOptions', True),
    'session_info_update': lambda u: None,
    'usage_update': _usage,
    'notice': lambda u: None,
    'compaction_update': _compaction,
    'compaction_summary_chunk': _compaction_chunk,
}


def validate_session_update(params):
    """Validate session/update params. Returns the update kind string (known or unknown)."""
    _obj(params, 'params')
    _str(params, 'sessionId', 'params', nonempty=True)
    update = _obj(params.get('update'), 'params.update')
    kind = _str(update, 'sessionUpdate', 'params.update', nonempty=True)
    check = UPDATE_VALIDATORS.get(kind)
    if check:
        check(update)
    return kind


# ---- agent -> client requests ---------------------------------------------

def validate_permission_request(params):
    _obj(params, 'params')
    _str(params, 'sessionId', 'params', nonempty=True)
    tool_call = _obj(params.get('toolCall'), 'params.toolCall')
    _str(tool_call, 'toolCallId', 'params.toolCall', nonempty=True)
    seen = set()
    for index, option in enumerate(_list(params.get('options'), 'params.options')):
        where = f'params.options[{index}]'
        _obj(option, where)
        option_id = _str(option, 'optionId', where, nonempty=True)
        _str(option, 'name', where)
        _str(option, 'kind', where)
        if option_id in seen:
            raise ProtocolError(f'{where}.optionId duplicates an earlier option')
        seen.add(option_id)


def validate_elicitation_request(params):
    """Envelope-level checks only; full schema/scope validation lives in elicitation.py."""
    _obj(params, 'params')
    _str(params, 'message', 'params')
    if 'mode' in params:
        _str(params, 'mode', 'params')


def validate_request(method, params):
    if method == 'session/request_permission':
        validate_permission_request(params)
    elif method == 'elicitation/create':
        validate_elicitation_request(params)


def validate_notification(method, params):
    """Returns the update kind for session/update, else None."""
    if method == 'session/update':
        return validate_session_update(params)
    if method == 'elicitation/complete':
        _str(_obj(params, 'params'), 'elicitationId', 'params')
    elif method == '$/cancel_request':
        request_id = _obj(params, 'params').get('requestId')
        if not _is_id(request_id):
            raise ProtocolError('params.requestId must be a string or integer')
    return None


# ---- agent -> client responses (results of requests Studio sent) -----------

def validate_initialize_result(result):
    _obj(result, 'result')
    version = result.get('protocolVersion')
    if isinstance(version, bool) or not isinstance(version, int):
        raise ProtocolError('result.protocolVersion must be an integer')
    if 'agentCapabilities' in result and result['agentCapabilities'] is not None:
        caps = _obj(result['agentCapabilities'], 'result.agentCapabilities')
        if 'promptCapabilities' in caps and caps['promptCapabilities'] is not None:
            _obj(caps['promptCapabilities'], 'result.agentCapabilities.promptCapabilities')
    if result.get('authMethods') is not None:
        for index, method in enumerate(_list(result['authMethods'], 'result.authMethods')):
            _str(_obj(method, f'result.authMethods[{index}]'), 'id', f'result.authMethods[{index}]')


def validate_new_session_result(result):
    _obj(result, 'result')
    _str(result, 'sessionId', 'result', nonempty=True)
    _validate_modes(result.get('modes'), 'result.modes')
    _validate_config_options(result.get('configOptions'), 'result.configOptions')


def validate_load_session_result(result):
    _obj(result, 'result')
    _validate_modes(result.get('modes'), 'result.modes')
    _validate_config_options(result.get('configOptions'), 'result.configOptions')


def validate_prompt_result(result):
    """Returns True when stopReason is a known value (unknown strings are tolerated by the caller)."""
    _obj(result, 'result')
    return _str(result, 'stopReason', 'result') in STOP_REASONS


RESULT_VALIDATORS = {
    'initialize': validate_initialize_result,
    'session/new': validate_new_session_result,
    'session/load': validate_load_session_result,
    'session/prompt': validate_prompt_result,
    'session/set_mode': lambda r: _obj(r, 'result'),
    'session/set_config_option': lambda r: (_obj(r, 'result'), _validate_config_options(r.get('configOptions'), 'result.configOptions')),
}


def validate_result(method, result):
    """Validate a successful response. Raises ProtocolError; returns None."""
    check = RESULT_VALIDATORS.get(method)
    if check:
        known = check(result)
        if method == 'session/prompt' and known is False:
            raise _Tolerated(f'Unknown stopReason {result.get("stopReason")!r}; passing it through')


class _Tolerated(ProtocolError):
    """Raised internally to log a warning for a value that is still accepted."""


# ---- connection integration ------------------------------------------------

def _state(connection):
    return connection.__dict__.setdefault('_acp_schema', {'logged': 0, 'unknown_kinds': set(), 'suppressed': 0})


def report(connection, message, **extra):
    """Record a protocol problem as an `error` event (capped), never raising."""
    state = _state(connection)
    state['logged'] += 1
    if state['logged'] > MAX_PROTOCOL_EVENTS:
        state['suppressed'] += 1
        return
    suffix = ' (further protocol errors on this connection are not logged)' if state['logged'] == MAX_PROTOCOL_EVENTS else ''
    connection.event('error', dict(message='ACP protocol: ' + message + suffix, protocol=True, **extra))


def _reply_error(connection, request_id, error):
    try:
        connection.write({'jsonrpc': '2.0', 'id': request_id, 'error': {'code': error.code, 'message': str(error)}})
    except (OSError, ValueError):
        pass


def _screen(connection, message):
    kind = message_kind(message)
    if kind == 'request':
        validate_request(message['method'], message.get('params', {}))
    elif kind == 'notification':
        update_kind = validate_notification(message['method'], message.get('params', {}))
        if update_kind and update_kind not in UPDATE_VALIDATORS and update_kind not in KNOWN_EXTENSION_UPDATES:
            state = _state(connection)
            if update_kind not in state['unknown_kinds'] and len(state['unknown_kinds']) < 100:
                state['unknown_kinds'].add(update_kind)
                report(connection, f'Unknown session/update kind {update_kind!r} tolerated (reported once)', kind='unknown_update')
    else:
        _screen_response(connection, message)
    return kind


def _screen_response(connection, message):
    """Returns normally for a valid response to a pending request; raises otherwise."""
    with connection.lock:
        waiting = connection.pending.get(message['id'])
        if waiting is None:
            raise _Dropped(f'Response to unknown request id {message["id"]!r} ignored')
        if waiting['done'].is_set() or 'response' in waiting:
            raise _Dropped(f'Duplicate response for request id {message["id"]!r} ignored')
        method = waiting.get('method')
    if 'result' in message:
        try:
            validate_result(method, message['result'])
        except _Tolerated as warning:
            report(connection, str(warning), method=method)
        except ProtocolError as error:
            # Fail the waiting RPC with a clear message instead of letting callers misread the result.
            with connection.lock:
                waiting['response'] = {'error': {'code': error.code, 'message': f'Malformed {method} response: {error}'}}
                waiting['done'].set()
            raise _Dropped(f'Malformed {method} response rejected: {error}')


def _fail_waiting(connection, request_id, text, code):
    if not _is_id(request_id):
        return
    with connection.lock:
        waiting = connection.pending.get(request_id)
        if waiting is not None and not waiting['done'].is_set() and 'response' not in waiting:
            waiting['response'] = {'error': {'code': code, 'message': text}}
            waiting['done'].set()


class _Dropped(ProtocolError):
    """Message is dropped and reported; no reply is sent (responses/notifications)."""


def screen(connection, line):
    """Parse and validate one agent stdout line. Returns the message dict to dispatch, or None."""
    if not isinstance(line, str) or not line.strip():
        return None
    try:
        try:
            message = json.loads(line)
        except ValueError:
            report(connection, 'Agent wrote a non-JSON line to stdout: ' + line.strip()[:200])
            return None
        try:
            _screen(connection, message)
            return message
        except _Dropped as error:
            report(connection, str(error))
        except ProtocolError as error:
            report(connection, f'{error} (in {_describe(message)})')
            if isinstance(message, dict) and 'method' in message and _is_id(message.get('id')):
                _reply_error(connection, message['id'], error)
            elif isinstance(message, dict) and 'method' not in message:
                _fail_waiting(connection, message.get('id'), f'Malformed response: {error}', error.code)
        return None
    except Exception as error:  # a validator bug must never kill the reader thread or hide messages
        log.exception('ACP validator failed; message passed through')
        try:
            report(connection, f'Validator failure ({type(error).__name__}: {error}); message passed through')
        except Exception:
            log.exception('Could not report the ACP validator failure to the connection')
        return message if isinstance(locals().get('message'), dict) else None


def _describe(message):
    if isinstance(message, dict):
        return str(message.get('method') or ('response' if 'id' in message else 'message'))
    return type(message).__name__
