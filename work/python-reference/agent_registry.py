"""The agent registry: built-in agents (OMP, Claude Code, Codex) plus ACP agents the user added in Settings.

Pure helpers, no I/O beyond looking a command up on disk / PATH. A user agent is {id, name, command, args, env, enabled}:
  id       "custom-<slug>", made once from the name and never changed (conversations are stored under it)
  command  an existing executable file path, or a bare name found on PATH; never run through a shell
  args     list of strings (one per line in the form)
  env      list of {name, value}; names match [A-Za-z_][A-Za-z0-9_]*. Values are stored as plain text in the state folder and are
           never sent to the page (hidden_env); an edit that leaves a value out keeps the stored one.
Saved-session discovery and transcript lookup are not available for user agents (only for the built-ins).
"""
import os
import pathlib
import re
import shutil

BUILTIN_IDS = ('omp', 'claude', 'codex')
BUILTIN_NAMES = {'omp': 'OMP', 'claude': 'Claude Code', 'codex': 'Codex'}
CUSTOM_PREFIX = 'custom-'
ID_RE = re.compile(r'^custom-[a-z0-9]+(?:-[a-z0-9]+)*$')
ENV_NAME_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
MAX_AGENTS = 20
MAX_NAME = 40
MAX_COMMAND = 1024
MAX_ARGS = 50
MAX_ARG = 2000
MAX_ENV = 50
MAX_ENV_VALUE = 4000


def is_provider(value):
    """A provider id Studio can store and launch: a built-in or a well-formed user-agent id."""
    return isinstance(value, str) and (value in BUILTIN_IDS or (len(value) <= 48 and bool(ID_RE.match(value))))


def is_custom(value):
    return isinstance(value, str) and len(value) <= 48 and bool(ID_RE.match(value))


def _line_text(value, limit):
    """One-line text: control characters become spaces, runs of spaces collapse."""
    if not isinstance(value, str):
        return ''
    return ' '.join(''.join(c if ord(c) >= 32 and ord(c) != 127 else ' ' for c in value).split())[:limit]


def slug(name):
    text = re.sub(r'[^a-z0-9]+', '-', _line_text(name, 80).lower()).strip('-')
    return text[:30].strip('-') or 'agent'


def make_id(name, taken):
    """custom-<slug>, with -2, -3 ... when the slug is already used."""
    base = CUSTOM_PREFIX + slug(name)
    candidate, n = base, 2
    while candidate in taken:
        candidate = f'{base}-{n}'
        n += 1
    return candidate


def check_command(command):
    """The absolute path of an existing executable file, or a bare name found on PATH. Raises ValueError otherwise."""
    if not isinstance(command, str):
        raise ValueError('Command must be text')
    text = command.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in '"\'':
        text = text[1:-1].strip()
    if not text or len(text) > MAX_COMMAND or any(ord(c) < 32 for c in text):
        raise ValueError('Enter the command to start the agent (a file path, or a program name on PATH)')
    if '/' in text or '\\' in text or (len(text) > 1 and text[1] == ':'):
        path = pathlib.Path(text).expanduser()
        if not path.is_absolute():
            raise ValueError('Use a full path to the program, or just its name if it is on PATH')
        if not path.is_file():
            raise ValueError(f'No file at {text}')
        if os.name != 'nt' and not os.access(path, os.X_OK):
            raise ValueError(f'{text} is not executable')
        return str(path.resolve())
    found = shutil.which(text)
    if not found:
        raise ValueError(f'"{text}" was not found on PATH')
    return str(pathlib.Path(found).resolve())


def command_status(command):
    """(resolved path or '', problem text or '') without raising; for the Agents list."""
    try:
        return check_command(command), ''
    except ValueError as error:
        return '', str(error)


def clean_args(value):
    """A list of strings, or the text of the form field (one argument per line; blank lines dropped)."""
    items = value.split('\n') if isinstance(value, str) else value
    if not isinstance(items, list):
        raise ValueError('Arguments must be a list')
    out = []
    for item in items:
        if not isinstance(item, str):
            raise ValueError('Each argument must be text')
        item = item.rstrip('\r')
        if not item.strip():
            continue
        if len(item) > MAX_ARG or '\x00' in item or '\n' in item:
            raise ValueError('An argument is too long or contains a control character')
        out.append(item)
    if len(out) > MAX_ARGS:
        raise ValueError(f'At most {MAX_ARGS} arguments')
    return out


def parse_env_text(text):
    """NAME=value lines -> [{name, value}]. Blank lines and lines starting with # are ignored."""
    out = []
    for line in str(text or '').split('\n'):
        line = line.rstrip('\r')
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        name, sep, value = line.partition('=')
        if not sep:
            raise ValueError(f'Environment line "{line[:40]}" needs the form NAME=value')
        out.append({'name': name.strip(), 'value': value})
    return out


def clean_env(value):
    items = parse_env_text(value) if isinstance(value, str) else value
    if not isinstance(items, list):
        raise ValueError('Environment variables must be a list')
    out, seen = [], set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not isinstance(item.get('value', ''), str):
            raise ValueError('Each environment variable needs a name and a value')
        name, val = item['name'].strip(), item.get('value', '')
        if not ENV_NAME_RE.match(name) or len(name) > 128:
            raise ValueError(f'"{name[:40]}" is not a valid variable name (letters, digits and _; not starting with a digit)')
        if len(val) > MAX_ENV_VALUE or '\x00' in val or '\n' in val:
            raise ValueError(f'The value of {name} is too long or contains a control character')
        if name.upper() in seen:
            raise ValueError(f'{name} is listed twice')
        seen.add(name.upper())
        out.append({'name': name, 'value': val})
    if len(out) > MAX_ENV:
        raise ValueError(f'At most {MAX_ENV} environment variables')
    return out


def hidden_env(env):
    """What the page may see of an agent's environment: names only, {name, set: true}. Values never leave the state folder."""
    return [{'name': e['name'], 'set': True} for e in env or [] if isinstance(e, dict) and isinstance(e.get('name'), str)]


def keep_stored_values(items, stored):
    """An edit may leave a value out (or send null): that variable keeps the value already stored under the same name
    (an empty value when it is new). Items that carry a value replace it. Text-form env (NAME=value lines) is left alone."""
    if not isinstance(items, list):
        return items
    old = {e['name']: e.get('value', '') for e in stored or [] if isinstance(e, dict) and isinstance(e.get('name'), str)}
    out = []
    for item in items:
        if isinstance(item, dict) and item.get('value') is None:
            name = item.get('name')
            item = {'name': name, 'value': old.get(name.strip(), '') if isinstance(name, str) else ''}
        out.append(item)
    return out


def clean_agent(raw, taken_ids=(), existing=None, check=True):
    """Validate one user agent from the form / a patch. existing: the stored agent being edited (keeps its id).
    check=False skips the "command exists" test (used when loading the file: an agent may be temporarily missing)."""
    if not isinstance(raw, dict):
        raise ValueError('Invalid agent')
    name = _line_text(raw.get('name'), MAX_NAME)
    if not name:
        raise ValueError('Give the agent a name')
    command = raw.get('command')
    if check:
        command = check_command(command)
        # keep what the user typed when it was a bare name found on PATH: it follows PATH changes
        typed = str(raw.get('command')).strip().strip('"\'')
        if typed and not any(s in typed for s in '/\\') and not (len(typed) > 1 and typed[1] == ':'):
            command = typed
    else:
        command = _line_text(command, MAX_COMMAND) if isinstance(command, str) else ''
        if not command:
            raise ValueError('Missing command')
    agent_id = (existing or {}).get('id') or make_id(name, set(taken_ids) | set(BUILTIN_IDS))
    if not is_custom(agent_id):
        raise ValueError('Invalid agent id')
    enabled = raw.get('enabled', (existing or {}).get('enabled', True))
    if not isinstance(enabled, bool):
        raise ValueError('enabled must be true or false')
    stored_env = (existing or {}).get('env') or []
    env = keep_stored_values(raw['env'], stored_env) if 'env' in raw else stored_env   # no env sent on an edit: keep what is stored
    return {'id': agent_id, 'name': name, 'command': command, 'args': clean_args(raw.get('args', [])), 'env': clean_env(env), 'enabled': enabled}


def letter_of(name):
    return (str(name).strip()[:1] or '?').upper()
